import { randomUUID } from "node:crypto"
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

const legacyProjectFileSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

const projectFileSchema = z.object({
  version: z.literal(2),
  format: z.literal("lg-novel"),
  id: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  lifecycle: z.enum(["shell", "active"]),
  origin: z.object({
    kind: z.enum(["new", "folder", "portable-copy"]),
    sourceId: z.string().min(1).optional(),
  }),
})

type LegacyProjectFile = z.infer<typeof legacyProjectFileSchema>
export type ProjectFile = z.infer<typeof projectFileSchema>

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

function currentProjectFile(legacy: LegacyProjectFile): ProjectFile {
  return {
    version: 2,
    format: "lg-novel",
    id: legacy.id,
    title: legacy.title,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
    lifecycle: "active",
    origin: { kind: "folder" },
  }
}

export async function readProjectFile(root: string): Promise<ProjectFile | null> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path.join(root, ".lg", "project.json"), "utf8")) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw new Error("无法读取 .lg/project.json；为避免覆盖，LG 没有接管这个目录", { cause: error })
  }
  const current = projectFileSchema.safeParse(value)
  if (current.success) return current.data
  const legacy = legacyProjectFileSchema.safeParse(value)
  if (legacy.success) return currentProjectFile(legacy.data)
  throw new Error("无法识别 .lg/project.json 的格式；为避免覆盖，LG 没有接管这个目录")
}

export async function writeProjectFile(root: string, project: ProjectFile): Promise<void> {
  const validated = projectFileSchema.parse(project)
  const filePath = path.join(root, ".lg", "project.json")
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8")
  try {
    await rename(temporaryPath, filePath)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

export function newProjectFile(title: string, origin: ProjectFile["origin"], lifecycle: ProjectFile["lifecycle"]): ProjectFile {
  const now = new Date().toISOString()
  return {
    version: 2,
    format: "lg-novel",
    id: randomUUID(),
    title,
    createdAt: now,
    updatedAt: now,
    lifecycle,
    origin,
  }
}

export function renderNovelFile(title: string): string {
  return `---\nformat: lg-novel\nformatVersion: 1\ntitle: ${JSON.stringify(title)}\n---\n\n# ${title}\n\n`
}

export function portableDirectoryName(title: string): string {
  const cleaned = Array.from(title.trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, " "))
    .slice(0, 80)
    .join("")
    .replace(/[. ]+$/g, "")
  if (!cleaned) throw new Error("书名不能为空")
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) {
    return `${cleaned}-小说`
  }
  return cleaned
}
