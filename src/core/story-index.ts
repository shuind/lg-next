import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import type { TextSnapshot } from "./atomic-text-store"
import { normalizeRelativePath, resolveInside } from "./paths"

const storyKindSchema = z.enum(["chapter", "outline", "setting", "material", "constraint", "other"])
export type StoryKind = z.infer<typeof storyKindSchema>

const chunkSchema = z.object({
  id: z.string(),
  path: z.string(),
  revision: z.string(),
  kind: storyKindSchema,
  heading: z.string().optional(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  text: z.string(),
  terms: z.array(z.string()),
  mentions: z.array(z.string()),
})

const indexedFileSchema = z.object({
  path: z.string(),
  revision: z.string(),
  kind: storyKindSchema,
  shard: z.string(),
  size: z.number().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  chunkCount: z.number().int().nonnegative(),
  indexedAt: z.iso.datetime(),
})

const manifestSchema = z.object({
  version: z.literal(2),
  builtAt: z.iso.datetime(),
  files: z.record(z.string(), indexedFileSchema),
})

const shardSchema = z.object({
  version: z.literal(1),
  path: z.string(),
  revision: z.string(),
  chunks: z.array(chunkSchema),
})

type StoryManifest = z.infer<typeof manifestSchema>
type IndexedFile = z.infer<typeof indexedFileSchema>
type StoryShard = z.infer<typeof shardSchema>
export type StoryIndexChunk = z.infer<typeof chunkSchema>

export interface StoryIndexStatus {
  state: "ready" | "stale" | "missing"
  builtAt?: string
  documentCount: number
  chunkCount: number
}

export interface StoryIndexHit extends StoryIndexChunk {
  score: number
  excerpt: string
  reasons: string[]
  stale: boolean
}

export interface SearchStoryInput {
  query?: string
  entities?: string[]
  pathGlob?: string
  kinds?: StoryKind[]
  beforeSequence?: number
  afterSequence?: number
  detail?: "paths" | "snippets"
  limit?: number
  cursor?: string
}

export interface SearchStoryResult {
  hits: StoryIndexHit[]
  nextCursor?: string
}

interface SourceMetadata {
  path: string
  size: number
  mtimeMs: number
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function kindForPath(relativePath: string): StoryKind {
  const normalized = normalizeRelativePath(relativePath)
  if (/^(章节正文|章节|正文)\//.test(normalized)) return "chapter"
  if (/(^|\/)(大纲|卷纲|章节大纲|章纲|剧情管理)(\/|$)/.test(normalized)) return "outline"
  if (/(^|\/)(设定|人物设定|世界观|状态追踪)(\/|$)/.test(normalized)) return "setting"
  if (/(^|\/)(素材|inbox)(\/|$)/i.test(normalized)) return "material"
  if (/(^|\/)(写作约束|约束)(\/|$)/.test(normalized)) return "constraint"
  return "other"
}

function sequenceForPath(relativePath: string): number | undefined {
  const matches = [...relativePath.matchAll(/(\d+)/g)]
  const value = matches.at(-1)?.[1]
  return value ? Number(value) : undefined
}

function terms(value: string): string[] {
  const normalized = value.toLowerCase().replace(/\s+/g, " ")
  const words = normalized.match(/[a-z0-9_]{2,}|[\u3400-\u9fff]+/g) ?? []
  const output = new Set<string>()
  for (const word of words) {
    output.add(word)
    if (/^[\u3400-\u9fff]+$/.test(word)) {
      for (let width = 2; width <= 3; width += 1) {
        for (let index = 0; index <= word.length - width; index += 1) output.add(word.slice(index, index + width))
      }
    }
  }
  return [...output]
}

function mentionsFor(text: string, heading?: string): string[] {
  const candidates = terms(`${heading ?? ""}\n${text}`)
  return candidates.filter((term) => /^[\u3400-\u9fff]{2,4}$/.test(term)).slice(0, 200)
}

function chunkDocument(source: TextSnapshot, maximum = 1800): StoryIndexChunk[] {
  const lines = source.content.split(/\r?\n/)
  const chunks: StoryIndexChunk[] = []
  const kind = kindForPath(source.path)
  let heading: string | undefined
  let startLine = 1
  let buffer: string[] = []
  let bufferSize = 0

  function flush(endLine: number): void {
    const text = buffer.join("\n").trim()
    if (text) {
      chunks.push({
        id: hash(`${source.path}:${source.revision}:${startLine}:${endLine}:${text}`).slice(0, 20),
        path: source.path,
        revision: source.revision,
        kind,
        heading,
        startLine,
        endLine,
        text,
        terms: terms(`${heading ?? ""}\n${text}`),
        mentions: mentionsFor(text, heading),
      })
    }
    buffer = []
    bufferSize = 0
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const nextHeading = /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1]
    if (nextHeading) {
      if (buffer.some((item) => item.trim())) flush(index)
      heading = nextHeading
      startLine = index + 1
    }
    if (bufferSize + line.length > maximum && buffer.some((item) => item.trim())) {
      flush(index)
      startLine = index + 1
    }
    if (buffer.length === 0) startLine = index + 1
    buffer.push(line)
    bufferSize += line.length + 1
    if (!line.trim() && bufferSize >= maximum * 0.68) {
      flush(index + 1)
      startLine = index + 2
    }
  }
  if (buffer.some((item) => item.trim())) flush(lines.length)
  return chunks
}

function excerpt(text: string, needles: string[], limit = 420): string {
  const compact = text.replace(/\s+/g, " ").trim()
  if (compact.length <= limit) return compact
  const lower = compact.toLowerCase()
  const indexes = needles.map((needle) => lower.indexOf(needle.toLowerCase())).filter((index) => index >= 0)
  const anchor = indexes.length ? Math.min(...indexes) : 0
  const start = Math.max(0, anchor - Math.floor(limit / 3))
  return `${start > 0 ? "…" : ""}${compact.slice(start, start + limit)}${start + limit < compact.length ? "…" : ""}`
}

function globPattern(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*")
  return new RegExp(`^${escaped}$`, "i")
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8")
  await rename(temporary, filePath)
}

export class StoryIndex {
  private readonly storyRoot: string
  private readonly manifestPath: string
  private operation: Promise<void> = Promise.resolve()
  private readonly shardCache = new Map<string, StoryShard>()

  constructor(
    private readonly root: string,
    private readonly listMarkdown: () => Promise<string[]>,
    private readonly readText: (relativePath: string) => Promise<TextSnapshot>,
  ) {
    this.storyRoot = path.join(root, ".lg", "index", "story")
    this.manifestPath = path.join(this.storyRoot, "manifest.json")
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation)
    this.operation = result.then(() => undefined, () => undefined)
    return result
  }

  private async loadManifest(): Promise<StoryManifest | null> {
    try {
      return manifestSchema.parse(JSON.parse(await readFile(this.manifestPath, "utf8")) as unknown)
    } catch {
      return null
    }
  }

  private async metadata(relativePath: string): Promise<SourceMetadata> {
    const normalized = normalizeRelativePath(relativePath)
    const sourceStat = await stat(resolveInside(this.root, normalized))
    return { path: normalized, size: sourceStat.size, mtimeMs: sourceStat.mtimeMs }
  }

  private shardName(relativePath: string): string {
    return `${hash(relativePath).slice(0, 24)}.json`
  }

  private async indexSnapshot(snapshot: TextSnapshot, metadata?: SourceMetadata): Promise<IndexedFile> {
    const sourceMetadata = metadata ?? await this.metadata(snapshot.path)
    const shardName = this.shardName(snapshot.path)
    const shard: StoryShard = {
      version: 1,
      path: snapshot.path,
      revision: snapshot.revision,
      chunks: chunkDocument(snapshot),
    }
    await writeJsonAtomic(path.join(this.storyRoot, "spans", shardName), shard)
    this.shardCache.set(`${snapshot.path}:${snapshot.revision}`, shard)
    return {
      path: snapshot.path,
      revision: snapshot.revision,
      kind: kindForPath(snapshot.path),
      shard: shardName,
      size: sourceMetadata.size,
      mtimeMs: sourceMetadata.mtimeMs,
      chunkCount: shard.chunks.length,
      indexedAt: new Date().toISOString(),
    }
  }

  private async synchronize(): Promise<StoryManifest> {
    const existing = await this.loadManifest()
    const files = await this.listMarkdown()
    const metadata = await Promise.all(files.map((file) => this.metadata(file)))
    const nextFiles: Record<string, IndexedFile> = {}

    for (const item of metadata) {
      const previous = existing?.files[item.path]
      if (previous && previous.size === item.size && previous.mtimeMs === item.mtimeMs) {
        nextFiles[item.path] = previous
        continue
      }
      nextFiles[item.path] = await this.indexSnapshot(await this.readText(item.path), item)
    }

    for (const previous of Object.values(existing?.files ?? {})) {
      if (nextFiles[previous.path]) continue
      await rm(path.join(this.storyRoot, "spans", previous.shard), { force: true }).catch(() => undefined)
      for (const key of this.shardCache.keys()) {
        if (key.startsWith(`${previous.path}:`)) this.shardCache.delete(key)
      }
    }

    const manifest: StoryManifest = { version: 2, builtAt: new Date().toISOString(), files: nextFiles }
    await writeJsonAtomic(this.manifestPath, manifest)
    return manifest
  }

  async status(): Promise<StoryIndexStatus> {
    const manifest = await this.loadManifest()
    const files = await this.listMarkdown()
    if (!manifest) return { state: "missing", documentCount: files.length, chunkCount: 0 }
    if (files.length !== Object.keys(manifest.files).length) {
      return { state: "stale", builtAt: manifest.builtAt, documentCount: files.length, chunkCount: Object.values(manifest.files).reduce((sum, file) => sum + file.chunkCount, 0) }
    }
    for (const file of files) {
      const indexed = manifest.files[file]
      if (!indexed) return { state: "stale", builtAt: manifest.builtAt, documentCount: files.length, chunkCount: 0 }
      const current = await this.metadata(file)
      if (current.size !== indexed.size || current.mtimeMs !== indexed.mtimeMs) {
        return { state: "stale", builtAt: manifest.builtAt, documentCount: files.length, chunkCount: Object.values(manifest.files).reduce((sum, item) => sum + item.chunkCount, 0) }
      }
    }
    return {
      state: "ready",
      builtAt: manifest.builtAt,
      documentCount: files.length,
      chunkCount: Object.values(manifest.files).reduce((sum, file) => sum + file.chunkCount, 0),
    }
  }

  async refresh(): Promise<StoryIndexStatus> {
    const manifest = await this.exclusive(() => this.synchronize())
    return {
      state: "ready",
      builtAt: manifest.builtAt,
      documentCount: Object.keys(manifest.files).length,
      chunkCount: Object.values(manifest.files).reduce((sum, file) => sum + file.chunkCount, 0),
    }
  }

  async update(relativePath: string, snapshot?: TextSnapshot): Promise<void> {
    const normalized = normalizeRelativePath(relativePath)
    await this.exclusive(async () => {
      const manifest = await this.loadManifest() ?? { version: 2 as const, builtAt: new Date().toISOString(), files: {} }
      const current = snapshot ?? await this.readText(normalized)
      manifest.files[normalized] = await this.indexSnapshot(current)
      manifest.builtAt = new Date().toISOString()
      await writeJsonAtomic(this.manifestPath, manifest)
    })
  }

  async remove(relativePath: string): Promise<void> {
    const normalized = normalizeRelativePath(relativePath)
    await this.exclusive(async () => {
      const manifest = await this.loadManifest()
      const indexed = manifest?.files[normalized]
      if (!manifest || !indexed) return
      delete manifest.files[normalized]
      manifest.builtAt = new Date().toISOString()
      await rm(path.join(this.storyRoot, "spans", indexed.shard), { force: true }).catch(() => undefined)
      await writeJsonAtomic(this.manifestPath, manifest)
    })
  }

  private async loadShard(file: IndexedFile): Promise<StoryShard | null> {
    const key = `${file.path}:${file.revision}`
    const cached = this.shardCache.get(key)
    if (cached) return cached
    try {
      const shard = shardSchema.parse(JSON.parse(await readFile(path.join(this.storyRoot, "spans", file.shard), "utf8")) as unknown)
      this.shardCache.set(key, shard)
      return shard
    } catch {
      return null
    }
  }

  async search(query: string, limit?: number): Promise<StoryIndexHit[]>
  async search(input: SearchStoryInput): Promise<StoryIndexHit[]>
  async search(queryOrInput: string | SearchStoryInput, limit = 12): Promise<StoryIndexHit[]> {
    return (await this.searchPage(typeof queryOrInput === "string" ? { query: queryOrInput, limit } : queryOrInput)).hits
  }

  async searchPage(input: SearchStoryInput): Promise<SearchStoryResult> {
    const manifest = await this.exclusive(() => this.synchronize())
    const cleanQuery = input.query?.trim() ?? ""
    const entities = [...new Set((input.entities ?? []).map((item) => item.trim()).filter(Boolean))]
    const needles = [...new Set([cleanQuery, ...entities].filter(Boolean))]
    if (!needles.length && !input.pathGlob && !input.kinds?.length) return { hits: [] }
    const queryTerms = terms(needles.join(" "))
    const pathMatcher = input.pathGlob ? globPattern(normalizeRelativePath(input.pathGlob)) : null
    const records = Object.values(manifest.files).filter((file) => {
      if (pathMatcher && !pathMatcher.test(file.path)) return false
      if (input.kinds?.length && !input.kinds.includes(file.kind)) return false
      const sequence = sequenceForPath(file.path)
      if (input.beforeSequence !== undefined && sequence !== undefined && sequence >= input.beforeSequence) return false
      if (input.afterSequence !== undefined && sequence !== undefined && sequence <= input.afterSequence) return false
      return true
    })
    const shards = await Promise.all(records.map(async (file) => {
      const loaded = await this.loadShard(file)
      if (loaded) return loaded
      await this.update(file.path)
      const repairedManifest = await this.loadManifest()
      const repaired = repairedManifest?.files[file.path]
      return repaired ? this.loadShard(repaired) : null
    }))
    const ranked = shards.flatMap((shard) => shard?.chunks ?? []).map((chunk) => {
      const haystack = `${chunk.path}\n${chunk.heading ?? ""}\n${chunk.text}`.toLowerCase()
      const reasons: string[] = []
      let score = 0
      if (cleanQuery && haystack.includes(cleanQuery.toLowerCase())) {
        score += 36
        reasons.push("完整短语")
      }
      for (const entity of entities) {
        if (haystack.includes(entity.toLowerCase())) {
          score += 10
          reasons.push(`实体:${entity}`)
        }
      }
      if (entities.length > 1 && entities.every((entity) => haystack.includes(entity.toLowerCase()))) {
        score += 18
        reasons.push("同段共现")
      }
      for (const term of queryTerms) {
        const occurrences = chunk.terms.filter((item) => item === term).length || haystack.split(term).length - 1
        if (occurrences > 0) score += Math.min(occurrences, 4) * (term.length > 2 ? 3 : 1)
      }
      if (cleanQuery && chunk.heading?.toLowerCase().includes(cleanQuery.toLowerCase())) {
        score += 14
        reasons.push("标题")
      }
      if (!needles.length) score = 1
      return {
        ...chunk,
        score,
        excerpt: input.detail === "paths" ? "" : excerpt(chunk.text, needles),
        reasons: [...new Set(reasons.length ? reasons : score > 0 ? ["词项命中"] : [])],
        stale: false,
      }
    }).filter((hit) => hit.score > 0)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path, "zh-CN", { numeric: true }) || left.startLine - right.startLine)

    const offset = Math.max(0, Number.parseInt(input.cursor ?? "0", 10) || 0)
    const pageLimit = Math.max(1, Math.min(input.limit ?? 12, 50))
    const hits = ranked.slice(offset, offset + pageLimit)
    return { hits, nextCursor: offset + hits.length < ranked.length ? String(offset + hits.length) : undefined }
  }
}
