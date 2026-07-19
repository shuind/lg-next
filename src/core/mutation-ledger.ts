import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

export const mutationActorSchema = z.enum(["user", "agent", "external-import", "system"])
export type MutationActor = z.infer<typeof mutationActorSchema>

const mutationLedgerEntrySchema = z.object({
  id: z.string(),
  createdAt: z.iso.datetime(),
  path: z.string(),
  operation: z.enum(["create", "replace", "edit", "delete", "restore"]),
  actor: mutationActorSchema,
  beforeRevision: z.string().optional(),
  afterRevision: z.string().optional(),
  reason: z.string().optional(),
  sourceTurnId: z.string().optional(),
})

export type MutationLedgerEntry = z.infer<typeof mutationLedgerEntrySchema>

export class MutationLedgerStore {
  private readonly filePath: string

  constructor(projectRoot: string) {
    this.filePath = path.join(projectRoot, ".lg", "ledger.jsonl")
  }

  async append(input: Omit<MutationLedgerEntry, "id" | "createdAt">): Promise<MutationLedgerEntry> {
    const entry = mutationLedgerEntrySchema.parse({
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    })
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8")
    return entry
  }

  async list(limit = 100): Promise<MutationLedgerEntry[]> {
    try {
      const entries: MutationLedgerEntry[] = []
      for (const line of (await readFile(this.filePath, "utf8")).split(/\r?\n/)) {
        if (!line.trim()) continue
        const parsed = mutationLedgerEntrySchema.safeParse(JSON.parse(line) as unknown)
        if (parsed.success) entries.push(parsed.data)
      }
      return entries.slice(-Math.max(1, Math.min(limit, 1000))).reverse()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
  }
}
