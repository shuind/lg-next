import { rm } from "node:fs/promises"
import type { AtomicTextStore, TextSnapshot } from "./atomic-text-store"
import type { StoryIndex } from "./story-index"
import { normalizeRelativePath, resolveInside } from "./paths"
import { MutationLedgerStore, type MutationActor, type MutationLedgerEntry } from "./mutation-ledger"

export interface WorkspaceMutation {
  path: string
  operation?: "create" | "replace" | "edit" | "delete"
  beforeRevision?: string
  afterContent?: string
  actor: MutationActor
  reason?: string
  sourceTurnId?: string
}

export interface MutationResult {
  path: string
  beforeRevision?: string
  afterRevision?: string
  content?: string
  changed: boolean
  ledger?: MutationLedgerEntry
}

const queues = new Map<string, Promise<void>>()

async function exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const current = previous.catch(() => undefined).then(() => gate)
  queues.set(key, current)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (queues.get(key) === current) queues.delete(key)
  }
}

async function optionalRead(store: AtomicTextStore, relativePath: string): Promise<TextSnapshot | null> {
  try {
    return await store.read(relativePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

export class WorkspaceMutationService {
  readonly ledger: MutationLedgerStore

  constructor(
    private readonly root: string,
    private readonly text: AtomicTextStore,
    private readonly storyIndex: StoryIndex,
    private readonly beforeMutation?: () => Promise<unknown>,
  ) {
    this.ledger = new MutationLedgerStore(root)
  }

  async apply(input: WorkspaceMutation): Promise<MutationResult> {
    const relativePath = normalizeRelativePath(input.path)
    return exclusive(this.root, async () => {
      const before = await optionalRead(this.text, relativePath)
      if (input.beforeRevision !== undefined && input.beforeRevision !== before?.revision) {
        throw new Error(`文件已变化，拒绝覆盖：${relativePath}`)
      }

      if (input.operation === "delete") {
        if (!before) return { path: relativePath, changed: false }
        await this.beforeMutation?.()
        await rm(resolveInside(this.root, relativePath))
        let ledger: MutationLedgerEntry
        try {
          ledger = await this.ledger.append({
            path: relativePath,
            operation: "delete",
            actor: input.actor,
            beforeRevision: before.revision,
            reason: input.reason,
            sourceTurnId: input.sourceTurnId,
          })
        } catch (error) {
          await this.text.write({ path: relativePath, content: before.content })
          throw error
        }
        await this.storyIndex.remove(relativePath).catch(() => undefined)
        return { path: relativePath, beforeRevision: before.revision, changed: true, ledger }
      }

      const content = input.afterContent ?? ""
      if (before?.content === content) {
        return {
          path: relativePath,
          beforeRevision: before.revision,
          afterRevision: before.revision,
          content: before.content,
          changed: false,
        }
      }

      await this.beforeMutation?.()
      const after = await this.text.write({
        path: relativePath,
        content,
        expectedRevision: before?.revision,
      })
      const operation = before ? (input.operation === "edit" ? "edit" : "replace") : "create"
      let ledger: MutationLedgerEntry
      try {
        ledger = await this.ledger.append({
          path: relativePath,
          operation,
          actor: input.actor,
          beforeRevision: before?.revision,
          afterRevision: after.revision,
          reason: input.reason,
          sourceTurnId: input.sourceTurnId,
        })
      } catch (error) {
        if (before) await this.text.write({ path: relativePath, content: before.content, expectedRevision: after.revision })
        else await rm(resolveInside(this.root, relativePath), { force: true })
        throw error
      }
      if (relativePath.toLowerCase().endsWith(".md")) await this.storyIndex.update(relativePath, after).catch(() => undefined)
      else await this.storyIndex.remove(relativePath).catch(() => undefined)
      return {
        path: relativePath,
        beforeRevision: before?.revision,
        afterRevision: after.revision,
        content: after.content,
        changed: true,
        ledger,
      }
    })
  }
}
