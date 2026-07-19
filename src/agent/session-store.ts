import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import { z } from "zod"

const boundarySchema = z.object({
  id: z.string(),
  createdAt: z.iso.datetime(),
  strategy: z.enum(["microcompact", "full-summary"]),
  tokenBefore: z.number().int().nonnegative(),
  tokenAfter: z.number().int().nonnegative(),
  changedMessages: z.number().int().nonnegative(),
  droppedGroups: z.number().int().nonnegative().optional(),
})

export type CompactionBoundary = z.infer<typeof boundarySchema>

export interface AgentSessionState {
  version: 1
  taskId: string
  updatedAt: string
  messages: ChatCompletionMessageParam[]
  lastCompactedAt?: string
  boundaries: CompactionBoundary[]
}

const sessionSchema = z.object({
  version: z.literal(1),
  taskId: z.string().min(1),
  updatedAt: z.iso.datetime(),
  messages: z.array(z.unknown()),
  lastCompactedAt: z.iso.datetime().optional(),
  boundaries: z.array(boundarySchema).default([]),
})

export class AgentSessionStore {
  private readonly directory: string

  constructor(projectRoot: string) {
    this.directory = path.join(projectRoot, ".lg", "sessions")
  }

  private filePath(taskId: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(taskId)) throw new Error("无效任务 ID")
    return path.join(this.directory, `${taskId}.json`)
  }

  async load(taskId: string): Promise<AgentSessionState | null> {
    try {
      const parsed = sessionSchema.parse(JSON.parse(await readFile(this.filePath(taskId), "utf8")) as unknown)
      return { ...parsed, messages: parsed.messages as ChatCompletionMessageParam[] }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      return null
    }
  }

  async save(state: AgentSessionState): Promise<void> {
    const filePath = this.filePath(state.taskId)
    await mkdir(path.dirname(filePath), { recursive: true })
    const temporary = `${filePath}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() })}\n`, "utf8")
    await rename(temporary, filePath)
  }
}
