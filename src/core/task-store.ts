import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

const taskRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export type TaskRecord = z.infer<typeof taskRecordSchema>

export class TaskStore {
  private readonly taskDir: string

  constructor(projectRoot: string) {
    this.taskDir = path.join(projectRoot, ".lg", "tasks")
  }

  async list(): Promise<TaskRecord[]> {
    const entries = await readdir(this.taskDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    })
    const tasks: TaskRecord[] = []

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue
      try {
        const raw = await readFile(path.join(this.taskDir, entry.name), "utf8")
        const parsed = taskRecordSchema.safeParse(JSON.parse(raw) as unknown)
        if (parsed.success) tasks.push(parsed.data)
      } catch {
        // A damaged task record must not hide the rest of the book.
      }
    }

    return tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async create(title: string): Promise<TaskRecord> {
    const cleanTitle = title.trim() || "新任务"
    const now = new Date().toISOString()
    const task: TaskRecord = {
      id: randomUUID(),
      title: cleanTitle,
      createdAt: now,
      updatedAt: now,
    }
    await mkdir(this.taskDir, { recursive: true })
    await writeFile(
      path.join(this.taskDir, `${task.id}.json`),
      `${JSON.stringify(task, null, 2)}\n`,
      "utf8",
    )
    return task
  }
}
