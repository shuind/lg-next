import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import type { RecentProject } from "../shared/contracts"

const recentProjectSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  lastOpenedAt: z.iso.datetime(),
})

const storeSchema = z.object({ version: z.literal(1), projects: z.array(recentProjectSchema) })

async function exists(target: string): Promise<boolean> {
  try { await access(target); return true } catch { return false }
}

export class RecentProjectStore {
  constructor(private readonly filePath: string) {}

  private async readAll(): Promise<RecentProject[]> {
    try {
      return storeSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")) as unknown).projects
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      return []
    }
  }

  private async writeAll(projects: RecentProject[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`, "utf8")
  }

  async list(): Promise<RecentProject[]> {
    const projects = await this.readAll()
    const available: RecentProject[] = []
    for (const project of projects) if (await exists(project.path)) available.push(project)
    if (available.length !== projects.length) await this.writeAll(available)
    return available
  }

  async record(project: { path: string; name: string }): Promise<void> {
    const normalized = path.resolve(project.path)
    const previous = await this.readAll()
    const next: RecentProject[] = [
      { path: normalized, name: project.name, lastOpenedAt: new Date().toISOString() },
      ...previous.filter((item) => path.resolve(item.path).toLowerCase() !== normalized.toLowerCase()),
    ].slice(0, 12)
    await this.writeAll(next)
  }
}
