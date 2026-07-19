import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { contentRevision } from "./revision"
import { normalizeRelativePath, resolveInside } from "./paths"

export interface TextSnapshot {
  path: string
  content: string
  revision: string
}

export interface TextMutation {
  path: string
  content: string
  expectedRevision?: string
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

export class AtomicTextStore {
  constructor(private readonly root: string) {}

  async read(relativePath: string): Promise<TextSnapshot> {
    const normalized = normalizeRelativePath(relativePath)
    const absolutePath = resolveInside(this.root, normalized)
    const content = await readFile(absolutePath, "utf8")
    return {
      path: normalized,
      content,
      revision: contentRevision(content),
    }
  }

  async write(input: TextMutation): Promise<TextSnapshot> {
    const normalized = normalizeRelativePath(input.path)
    const absolutePath = resolveInside(this.root, normalized)
    const before = await readOptional(absolutePath)
    const actualRevision = before === null ? null : contentRevision(before)

    if (input.expectedRevision !== undefined && input.expectedRevision !== actualRevision) {
      throw new Error(`文件已变化，拒绝覆盖：${normalized}`)
    }

    await mkdir(path.dirname(absolutePath), { recursive: true })
    const temporaryPath = `${absolutePath}.lg-${randomUUID()}.tmp`
    await writeFile(temporaryPath, input.content, "utf8")
    try {
      await rename(temporaryPath, absolutePath)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }

    return {
      path: normalized,
      content: input.content,
      revision: contentRevision(input.content),
    }
  }
}

