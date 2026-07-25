import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { AtomicTextStore, type TextMutation, type TextSnapshot } from "./atomic-text-store"
import { inspectBook, type BookSourceKind } from "./book-discovery"
import { newProjectFile, pathExists, portableDirectoryName, readProjectFile, renderNovelFile, writeProjectFile, type ProjectFile } from "./book-format"
import { GitVersionStore, type CheckpointResult } from "./git-version-store"
import { TaskStore, type TaskRecord } from "./task-store"
import { TaskEventStore } from "./task-event-store"
import { normalizeRelativePath } from "./paths"
import { StoryIndex } from "./story-index"
import { WorkspaceMutationService } from "./workspace-mutation"
import { CorrectionStore } from "./correction-store"
import type { ApiCallRecord, ProjectUsageStats } from "../shared/contracts"

export interface ProjectSnapshot {
  id: string
  name: string
  path: string
  tasks: TaskRecord[]
  files: string[]
  sourceKind: BookSourceKind
  lifecycle: "shell" | "active" | "external"
}

export interface ProjectMutationResult extends TextSnapshot {
  checkpoint: CheckpointResult
}

const DEFAULT_GITIGNORE = `.lg/\n`

async function ensureFile(filePath: string, content: string): Promise<void> {
  if (await pathExists(filePath)) return
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content, "utf8")
}

async function ensureGitignoreEntry(filePath: string, entry: string): Promise<void> {
  const content = await readFile(filePath, "utf8")
  if (content.split(/\r?\n/).includes(entry)) return
  await writeFile(filePath, `${content.replace(/\s*$/, "")}\n${entry}\n`, "utf8")
}

async function walkMarkdown(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true })
  const results: string[] = []
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === ".lg" || entry.name === "node_modules") continue
    const absolutePath = path.join(current, entry.name)
    if (entry.isDirectory()) {
      results.push(...await walkMarkdown(root, absolutePath))
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      results.push(normalizeRelativePath(path.relative(root, absolutePath)))
    }
  }
  return results
}

export class ProjectRuntime {
  readonly text: AtomicTextStore
  readonly tasks: TaskStore
  readonly events: TaskEventStore
  readonly versions: GitVersionStore
  readonly storyIndex: StoryIndex
  readonly mutations: WorkspaceMutationService
  readonly corrections: CorrectionStore

  constructor(readonly root: string) {
    this.text = new AtomicTextStore(root)
    this.tasks = new TaskStore(root)
    this.events = new TaskEventStore(root)
    this.versions = new GitVersionStore(root)
    this.storyIndex = new StoryIndex(root, () => this.listMarkdown(), (relativePath) => this.readText(relativePath))
    this.mutations = new WorkspaceMutationService(root, this.text, this.storyIndex, () => this.versions.ensureBaseline())
    this.corrections = new CorrectionStore(root)
  }

  static async createBook(parentPath: string, title: string): Promise<ProjectSnapshot> {
    const cleanTitle = title.trim()
    if (!cleanTitle) throw new Error("书名不能为空")
    const root = path.join(path.resolve(parentPath), portableDirectoryName(cleanTitle))
    if (await pathExists(root)) throw new Error(`“${path.basename(root)}”已经存在，请换一个书名或直接打开它`)
    await mkdir(root)
    try {
      const project = newProjectFile(cleanTitle, { kind: "new" }, "shell")
      await Promise.all([
        writeFile(path.join(root, "NOVEL.md"), renderNovelFile(cleanTitle), "utf8"),
        writeFile(path.join(root, ".gitignore"), DEFAULT_GITIGNORE, "utf8"),
        writeProjectFile(root, project),
      ])
      return new ProjectRuntime(root).load()
    } catch (error) {
      await rm(root, { recursive: true, force: true })
      throw error
    }
  }

  async load(): Promise<ProjectSnapshot> {
    const absoluteRoot = path.resolve(this.root)
    const inspection = await inspectBook(absoluteRoot)
    const tasks = await this.tasks.list()

    return {
      id: inspection.projectId,
      name: inspection.title,
      path: absoluteRoot,
      tasks,
      files: inspection.markdownFiles,
      sourceKind: inspection.kind,
      lifecycle: inspection.lifecycle,
    }
  }

  async initialize(): Promise<ProjectSnapshot> {
    const existing = await readProjectFile(this.root)
    if (!existing) await this.activate()
    return this.load()
  }

  private async activate(): Promise<ProjectFile> {
    const existing = await readProjectFile(this.root)
    const inspection = existing ? null : await inspectBook(this.root)
    const project: ProjectFile = existing
      ? { ...existing, lifecycle: "active", updatedAt: new Date().toISOString() }
      : newProjectFile(inspection?.title ?? path.basename(path.resolve(this.root)), { kind: inspection?.kind === "portable-book" ? "portable-copy" : "folder" }, "active")
    await writeProjectFile(this.root, project)
    const gitignorePath = path.join(this.root, ".gitignore")
    await ensureFile(gitignorePath, DEFAULT_GITIGNORE)
    await ensureGitignoreEntry(gitignorePath, ".lg/")
    return project
  }

  async createTask(title: string): Promise<TaskRecord> {
    await this.activate()
    return this.tasks.create(title)
  }

  async listMarkdown(): Promise<string[]> {
    return (await walkMarkdown(this.root)).sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }))
  }

  async readText(relativePath: string): Promise<TextSnapshot> {
    return this.text.read(relativePath)
  }

  async refreshStoryIndex(): Promise<Awaited<ReturnType<StoryIndex["refresh"]>>> {
    await this.activate()
    return this.storyIndex.refresh()
  }

  async searchStoryIndex(query: string, limit?: number): Promise<Awaited<ReturnType<StoryIndex["search"]>>> {
    await this.activate()
    return this.storyIndex.search(query, limit)
  }

  async listVersions(limit?: number): Promise<Awaited<ReturnType<GitVersionStore["list"]>>> {
    await this.activate()
    return this.versions.list(limit)
  }

  async writeText(input: TextMutation, checkpointLabel?: string): Promise<ProjectMutationResult> {
    await this.activate()
    const mutation = await this.mutations.apply({
      path: input.path,
      operation: "replace",
      beforeRevision: input.expectedRevision,
      afterContent: input.content,
      actor: checkpointLabel ? "user" : "agent",
      reason: checkpointLabel,
    })
    const checkpoint = checkpointLabel && mutation.changed
      ? await this.versions.checkpoint(checkpointLabel)
      : { created: false }
    return {
      path: mutation.path,
      content: mutation.content ?? input.content,
      revision: mutation.afterRevision ?? mutation.beforeRevision ?? "",
      checkpoint,
    }
  }

  async restoreVersion(commit: string, label: string): Promise<CheckpointResult> {
    await this.activate()
    const result = await this.versions.restore(commit, label)
    await this.storyIndex.refresh()
    return result
  }

  async usageStats(): Promise<ProjectUsageStats> {
    const project = await this.load()
    const eventGroups = await Promise.all(project.tasks.map((task) => this.events.list(task.id)))
    const events = eventGroups.flat()
    const activeDates = new Set<string>()
    const changedPaths = new Set<string>()
    const daily = new Map<string, { runs: number; tokens: number }>()
    const now = new Date()

    const dateKey = (value: string | Date): string => {
      const date = typeof value === "string" ? new Date(value) : value
      const year = date.getFullYear()
      const month = String(date.getMonth() + 1).padStart(2, "0")
      const day = String(date.getDate()).padStart(2, "0")
      return `${year}-${month}-${day}`
    }

    for (let offset = 13; offset >= 0; offset -= 1) {
      const date = new Date(now)
      date.setDate(date.getDate() - offset)
      daily.set(dateKey(date), { runs: 0, tokens: 0 })
    }

    let runCount = 0
    let promptTokens = 0
    let completionTokens = 0
    let lastActiveAt: string | undefined
    for (const event of events) {
      const day = dateKey(event.createdAt)
      activeDates.add(day)
      if (!lastActiveAt || event.createdAt > lastActiveAt) lastActiveAt = event.createdAt
      if (event.type !== "done") continue
      runCount += 1
      for (const changedPath of event.changedPaths) changedPaths.add(changedPath)
      const dayUsage = daily.get(day)
      if (dayUsage) dayUsage.runs += 1
      if (event.usage) {
        promptTokens += event.usage.promptTokens
        completionTokens += event.usage.completionTokens
        if (dayUsage) dayUsage.tokens += event.usage.totalTokens
      }
    }

    const contentFiles = project.files.filter((file) => file.toLowerCase() !== "novel.md")
    const documents = await Promise.all(contentFiles.map((file) => this.readText(file).catch(() => null)))
    const characterCount = documents.reduce((total, document) => total + (document?.content.replace(/\s/g, "").length ?? 0), 0)

    return {
      projectName: project.name,
      taskCount: project.tasks.length,
      messageCount: events.filter((event) => event.type === "user_message" || event.type === "assistant_message").length,
      runCount,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      characterCount,
      changedFileCount: changedPaths.size,
      activeDayCount: activeDates.size,
      lastActiveAt,
      daily: [...daily].map(([date, usage]) => ({ date, ...usage })),
    }
  }

  async apiCallRecords(limit = 200): Promise<ApiCallRecord[]> {
    const tasks = await this.tasks.list()
    const eventGroups = await Promise.all(tasks.map((task) => this.events.list(task.id)))
    return eventGroups
      .flat()
      .filter((event): event is ApiCallRecord => event.type === "api_call")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(1, Math.min(1000, limit)))
  }
}
