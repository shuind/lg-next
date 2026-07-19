import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

const correctionTargetSchema = z.object({
  path: z.string().min(1),
  revision: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
})

const correctionSchema = z.object({
  id: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  userText: z.string().min(1),
  sourceTurnId: z.string().min(1),
  targets: z.array(correctionTargetSchema),
  scopeHints: z.object({
    characters: z.array(z.string()).optional(),
    relationships: z.array(z.array(z.string())).optional(),
    chapters: z.array(z.string()).optional(),
  }).optional(),
  resolution: z.object({
    ledgerIds: z.array(z.string()),
    note: z.string().optional(),
  }).optional(),
  status: z.enum(["active", "resolved", "superseded"]),
})

export type ProjectCorrection = z.infer<typeof correctionSchema>
export type CorrectionTarget = z.infer<typeof correctionTargetSchema>

function queryTerms(value: string): string[] {
  const groups = value.toLowerCase().match(/[a-z0-9_]{2,}|[\u3400-\u9fff]+/g) ?? []
  const output = new Set<string>()
  for (const group of groups) {
    output.add(group)
    if (/^[\u3400-\u9fff]+$/.test(group)) {
      for (let index = 0; index < group.length - 1; index += 1) output.add(group.slice(index, index + 2))
    }
  }
  return [...output]
}

export class CorrectionStore {
  private readonly filePath: string
  private queue: Promise<void> = Promise.resolve()

  constructor(projectRoot: string) {
    this.filePath = path.join(projectRoot, ".lg", "corrections.jsonl")
  }

  async list(): Promise<ProjectCorrection[]> {
    let raw: string
    try {
      raw = await readFile(this.filePath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    const current = new Map<string, ProjectCorrection>()
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const parsed = correctionSchema.safeParse(JSON.parse(line) as unknown)
        if (parsed.success) current.set(parsed.data.id, parsed.data)
      } catch {
        // A partial trailing line must not hide earlier corrections.
      }
    }
    return [...current.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  private append(correction: ProjectCorrection): Promise<void> {
    const validated = correctionSchema.parse(correction)
    const operation = this.queue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true })
      await appendFile(this.filePath, `${JSON.stringify(validated)}\n`, "utf8")
    })
    this.queue = operation.catch(() => undefined)
    return operation
  }

  async record(input: {
    userText: string
    sourceTurnId: string
    targets: CorrectionTarget[]
    scopeHints?: ProjectCorrection["scopeHints"]
  }): Promise<ProjectCorrection> {
    const now = new Date().toISOString()
    const correction = correctionSchema.parse({
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      userText: input.userText.trim(),
      sourceTurnId: input.sourceTurnId,
      targets: input.targets,
      scopeHints: input.scopeHints,
      status: "active",
    })
    await this.append(correction)
    return correction
  }

  async resolve(id: string, input: { ledgerIds: string[]; note?: string; status?: "resolved" | "superseded" }): Promise<ProjectCorrection> {
    const current = (await this.list()).find((item) => item.id === id)
    if (!current) throw new Error("项目纠正不存在")
    const updated = correctionSchema.parse({
      ...current,
      updatedAt: new Date().toISOString(),
      resolution: { ledgerIds: input.ledgerIds, note: input.note },
      status: input.status ?? "resolved",
    })
    await this.append(updated)
    return updated
  }

  async search(query: string, limit = 6): Promise<Array<ProjectCorrection & { score: number }>> {
    const clean = query.trim().toLowerCase()
    const terms = queryTerms(clean)
    if (!clean || !terms.length) return []
    return (await this.list()).map((correction) => {
      const haystack = [
        correction.userText,
        ...correction.targets.map((target) => target.path),
        ...(correction.scopeHints?.characters ?? []),
        ...(correction.scopeHints?.relationships ?? []).flat(),
        ...(correction.scopeHints?.chapters ?? []),
      ].join("\n").toLowerCase()
      let score = haystack.includes(clean) ? 40 : 0
      for (const term of terms) score += Math.min(haystack.split(term).length - 1, 4) * (term.length > 2 ? 4 : 1)
      if (correction.status === "active") score *= 1.15
      return { ...correction, score }
    }).filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.max(1, Math.min(limit, 20)))
  }
}
