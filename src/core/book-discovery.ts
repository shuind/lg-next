import { createHash } from "node:crypto"
import { readFile, readdir, stat } from "node:fs/promises"
import path from "node:path"
import { readProjectFile } from "./book-format"

export type BookSourceKind = "lg-next" | "portable-book" | "markdown-folder" | "empty"

export interface BookInspection {
  path: string
  title: string
  kind: BookSourceKind
  markdownCount: number
  markdownFiles: string[]
  hasNovelFile: boolean
  projectId: string
  lifecycle: "shell" | "active" | "external"
}

async function markdownFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true })
  const results: string[] = []
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === ".lg" || entry.name === "node_modules") continue
    const absolute = path.join(current, entry.name)
    if (entry.isDirectory()) results.push(...await markdownFiles(root, absolute))
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) results.push(path.relative(root, absolute).replaceAll("\\", "/"))
  }
  return results
}

function externalProjectId(root: string): string {
  return `folder-${createHash("sha256").update(path.resolve(root).toLowerCase()).digest("hex").slice(0, 20)}`
}

async function portableNovelTitle(root: string): Promise<string | null> {
  try {
    const content = (await readFile(path.join(root, "NOVEL.md"), "utf8")).slice(0, 16_000)
    const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1]
    if (!frontmatter || !/^format:\s*lg-novel\s*$/mi.test(frontmatter)) return null
    const value = /^title:\s*(.+?)\s*$/mi.exec(frontmatter)?.[1]
    if (!value) return path.basename(root)
    try {
      const parsed = JSON.parse(value) as unknown
      return typeof parsed === "string" && parsed.trim() ? parsed.trim() : path.basename(root)
    } catch {
      return value.replace(/^['"]|['"]$/g, "").trim() || path.basename(root)
    }
  } catch {
    return null
  }
}

export async function inspectBook(root: string): Promise<BookInspection> {
  const absoluteRoot = path.resolve(root)
  const rootStat = await stat(absoluteRoot)
  if (!rootStat.isDirectory()) throw new Error("请选择作品文件夹")
  const [project, markdown, portableTitle] = await Promise.all([readProjectFile(absoluteRoot), markdownFiles(absoluteRoot), portableNovelTitle(absoluteRoot)])
  return {
    path: absoluteRoot,
    title: project?.title ?? portableTitle ?? path.basename(absoluteRoot),
    kind: project ? "lg-next" : portableTitle ? "portable-book" : markdown.length ? "markdown-folder" : "empty",
    markdownCount: markdown.length,
    markdownFiles: markdown.sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true })),
    hasNovelFile: markdown.some((file) => file.replaceAll("\\", "/").toLowerCase() === "novel.md"),
    projectId: project?.id ?? externalProjectId(absoluteRoot),
    lifecycle: project?.lifecycle ?? "external",
  }
}
