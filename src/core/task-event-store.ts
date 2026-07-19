import { appendFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { taskEventSchema, type TaskEvent } from "../shared/contracts"

export class TaskEventStore {
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly projectRoot: string) {}

  private eventPath(taskId: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(taskId)) throw new Error("无效任务 ID")
    return path.join(this.projectRoot, ".lg", "events", `${taskId}.jsonl`)
  }

  async list(taskId: string): Promise<TaskEvent[]> {
    let raw: string
    try {
      raw = await readFile(this.eventPath(taskId), "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }

    const events: TaskEvent[] = []
    const eventIndexes = new Map<string, number>()
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const parsed = taskEventSchema.safeParse(JSON.parse(line) as unknown)
        if (!parsed.success) continue
        const existingIndex = eventIndexes.get(parsed.data.id)
        if (existingIndex === undefined) {
          eventIndexes.set(parsed.data.id, events.length)
          events.push(parsed.data)
        } else {
          events[existingIndex] = parsed.data
        }
      } catch {
        // Append-only logs may end with a partial line after an interrupted write.
      }
    }
    return events
  }

  async append(event: TaskEvent): Promise<void> {
    const validated = taskEventSchema.parse(event)
    const eventPath = this.eventPath(validated.taskId)
    const operation = this.queue.then(async () => {
      await mkdir(path.dirname(eventPath), { recursive: true })
      await appendFile(eventPath, `${JSON.stringify(validated)}\n`, "utf8")
    })
    this.queue = operation.catch(() => undefined)
    return operation
  }
}
