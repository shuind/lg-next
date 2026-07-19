import { randomUUID } from "node:crypto"
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen, type WebContents } from "electron"
import path from "node:path"
import { access } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import type { OpenedProject, ProjectUsageStats } from "../shared/contracts"
import { ProjectRuntime } from "../core/project-runtime"
import { AgentProcess } from "./agent-process"
import { loadModelConfig, modelSettings, modelStatus, saveModelSettings, testModel } from "./model-config"
import type { AgentHistoryMessage, AgentWorkerEvent } from "../agent/protocol"
import type { TaskEvent } from "../shared/contracts"
import { applyRelayResponse, createRelayPackage, inspectRelayResponse } from "./relay-service"
import { recallTaskHistory, type RecallableMessage } from "./history-recall"
import { RecentProjectStore } from "./recent-project-store"

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const activeProjects = new Map<string, ProjectRuntime>()
const agentProcess = new AgentProcess()
const activeRuns = new Map<string, {
  projectPath: string
  sender: WebContents
  runtime: ProjectRuntime
}>()
const runningProjects = new Set<string>()

function activeProject(projectPath: string): ProjectRuntime {
  const normalized = path.resolve(projectPath)
  const runtime = activeProjects.get(normalized)
  if (!runtime) throw new Error("作品尚未在当前应用中打开")
  return runtime
}

function recentProjects(): RecentProjectStore {
  return new RecentProjectStore(path.join(app.getPath("userData"), "recent-projects.json"))
}

function emptyUsageStats(): ProjectUsageStats {
  const daily = Array.from({ length: 14 }, (_, index) => {
    const date = new Date()
    date.setDate(date.getDate() - (13 - index))
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, "0")
    const day = String(date.getDate()).padStart(2, "0")
    return { date: `${year}-${month}-${day}`, runs: 0, tokens: 0 }
  })
  return {
    taskCount: 0,
    messageCount: 0,
    runCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    characterCount: 0,
    changedFileCount: 0,
    activeDayCount: 0,
    daily,
  }
}

async function openProjectAt(projectPath: string, requireExisting = true): Promise<OpenedProject> {
  const normalized = path.resolve(projectPath)
  if (requireExisting) await access(normalized)
  const runtime = new ProjectRuntime(normalized)
  const project = await runtime.load()
  activeProjects.set(normalized, runtime)
  await recentProjects().record(project)
  return project
}

function shouldPersistAgentEvent(event: TaskEvent): boolean {
  return event.type !== "assistant_delta"
}

agentProcess.onEvent((message: AgentWorkerEvent) => {
  const run = activeRuns.get(message.requestId)
  if (!run) return
  const event = message.event
  if (shouldPersistAgentEvent(event)) {
    void run.runtime.events.append(event).catch((error) => {
      console.error("Failed to persist Agent event", error)
    })
  }
  if (!run.sender.isDestroyed()) run.sender.send("agent:event", event)
  if (event.type === "done") {
    activeRuns.delete(message.requestId)
    runningProjects.delete(run.projectPath)
  }
})

function createWindow(): void {
  const integratedTitleBar = process.platform === "win32"
  const workArea = screen.getPrimaryDisplay().workAreaSize
  const window = new BrowserWindow({
    width: Math.min(1672, workArea.width),
    height: Math.min(941, workArea.height),
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: "#f9f2e8",
    show: false,
    autoHideMenuBar: true,
    ...(integratedTitleBar ? {
      titleBarStyle: "hidden" as const,
      titleBarOverlay: {
        color: "#f9f2e8",
        symbolColor: "#6f6960",
        height: 52,
      },
    } : {}),
    webPreferences: {
      preload: path.join(currentDir, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
    },
  })

  window.setMenuBarVisibility(false)

  if (process.env.LG_SMOKE !== "1") window.once("ready-to-show", () => window.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(path.join(currentDir, "../renderer/index.html"))
  }
}

ipcMain.handle("project:open", async (): Promise<OpenedProject | null> => {
  const result = await dialog.showOpenDialog({
    title: "打开一本书",
    buttonLabel: "打开这本书",
    properties: ["openDirectory"],
  })
  const selectedPath = result.filePaths[0]
  if (result.canceled || !selectedPath) return null
  return openProjectAt(selectedPath, false)
})

ipcMain.handle("project:create", async (_event, title: string): Promise<OpenedProject | null> => {
  const cleanTitle = title.trim()
  if (!cleanTitle) throw new Error("书名不能为空")
  const result = await dialog.showOpenDialog({
    title: `选择“${cleanTitle}”的保存位置`,
    buttonLabel: "在这里创建",
    defaultPath: app.getPath("documents"),
    properties: ["openDirectory", "createDirectory"],
  })
  const parentPath = result.filePaths[0]
  if (result.canceled || !parentPath) return null
  const created = await ProjectRuntime.createBook(parentPath, cleanTitle)
  return openProjectAt(created.path)
})

ipcMain.handle("project:restore", async (): Promise<OpenedProject | null> => {
  for (const recent of await recentProjects().list()) {
    try { return await openProjectAt(recent.path) } catch (error) { console.error("Failed to restore recent project", error) }
  }
  return null
})

ipcMain.handle("project:open-recent", (_event, projectPath: string) => openProjectAt(projectPath))
ipcMain.handle("project:list-recent", () => recentProjects().list())

ipcMain.handle("task:create", async (_event, projectPath: string, title: string) => {
  return activeProject(projectPath).createTask(title)
})

ipcMain.handle("project:list-markdown", async (_event, projectPath: string) => {
  return activeProject(projectPath).listMarkdown()
})

ipcMain.handle("project:read-text", async (_event, projectPath: string, relativePath: string) => {
  return activeProject(projectPath).readText(relativePath)
})

ipcMain.handle("project:write-text", async (_event, input: {
  projectPath: string
  relativePath: string
  content: string
  expectedRevision?: string
  checkpointLabel: string
}) => {
  return activeProject(input.projectPath).writeText({
    path: input.relativePath,
    content: input.content,
    expectedRevision: input.expectedRevision,
  }, input.checkpointLabel)
})

ipcMain.handle("task:list-events", async (_event, projectPath: string, taskId: string) => {
  return activeProject(projectPath).events.list(taskId)
})

ipcMain.handle("model:status", () => modelStatus())
ipcMain.handle("model:settings", () => modelSettings())
ipcMain.handle("model:save", (_event, input) => saveModelSettings(input))
ipcMain.handle("model:test", (_event, input) => testModel(input))
ipcMain.handle("usage:project", (_event, projectPath?: string) => projectPath ? activeProject(projectPath).usageStats() : emptyUsageStats())
ipcMain.handle("story-index:status", (_event, projectPath: string) => activeProject(projectPath).storyIndex.status())
ipcMain.handle("story-index:refresh", (_event, projectPath: string) => activeProject(projectPath).refreshStoryIndex())
ipcMain.handle("story-index:search", (_event, projectPath: string, query: string, limit?: number) => activeProject(projectPath).searchStoryIndex(query, limit))
ipcMain.handle("relay:create", (_event, input) => createRelayPackage(activeProject(input.projectPath), input))
ipcMain.handle("relay:inspect", (_event, input) => inspectRelayResponse(activeProject(input.projectPath), input.sessionId, input.response))
ipcMain.handle("relay:apply", (_event, input) => applyRelayResponse(activeProject(input.projectPath), input.sessionId, input.response))
ipcMain.handle("clipboard:write", (_event, text: string) => { clipboard.writeText(text) })
ipcMain.handle("version:list", (_event, projectPath: string, limit?: number) => activeProject(projectPath).listVersions(limit))
ipcMain.handle("version:diff", async (_event, projectPath: string, commit: string) => ({ commit, patch: await activeProject(projectPath).versions.diff(commit) }))
ipcMain.handle("version:restore", (_event, projectPath: string, commit: string, label: string) => activeProject(projectPath).restoreVersion(commit, label))

ipcMain.handle("agent:run", async (event, input: {
  projectPath: string
  taskId: string
  message: string
  activeDocumentPath?: string
}) => {
  const projectPath = path.resolve(input.projectPath)
  if (runningProjects.has(projectPath)) throw new Error("这本书已有一个 Agent 任务正在运行")
  const runtime = activeProject(projectPath)
  const model = await loadModelConfig()
  if (!model) {
    throw new Error("尚未配置模型。请设置 LG_API_KEY、LG_BASE_URL 和 LG_MODEL。")
  }
  const message = input.message.trim()
  if (!message) throw new Error("消息不能为空")
  const taskExists = (await runtime.tasks.list()).some((task) => task.id === input.taskId)
  if (!taskExists) throw new Error("任务不存在")

  const requestId = randomUUID()
  const userEvent: TaskEvent = {
    id: randomUUID(),
    taskId: input.taskId,
    requestId,
    type: "user_message",
    createdAt: new Date().toISOString(),
    text: message,
  }
  await runtime.events.append(userEvent)
  if (!event.sender.isDestroyed()) event.sender.send("agent:event", userEvent)

  const persisted = await runtime.events.list(input.taskId)
  const messageEvents: RecallableMessage[] = []
  for (const item of persisted) {
    if (item.type === "user_message" && item.id !== userEvent.id) messageEvents.push({ id: item.id, role: "user", content: item.text, createdAt: item.createdAt })
    if (item.type === "assistant_message") messageEvents.push({ id: item.id, role: "assistant", content: item.text, createdAt: item.createdAt })
  }
  const boundedEvents: RecallableMessage[] = []
  let historyCharacters = 0
  for (const item of messageEvents.slice().reverse()) {
    if (boundedEvents.length >= 16 || (boundedEvents.length > 0 && historyCharacters + item.content.length > 18_000)) break
    boundedEvents.unshift(item)
    historyCharacters += item.content.length
  }
  const boundedIds = new Set(boundedEvents.map((item) => item.id))
  const recalledHistory = recallTaskHistory({
    query: message,
    candidates: messageEvents.filter((item) => !boundedIds.has(item.id)),
  }).map(({ role, content, createdAt, excerpt }) => ({ role, content, createdAt, excerpt }))
  const boundedHistory: AgentHistoryMessage[] = boundedEvents.map(({ role, content }) => ({ role, content }))
  const recentPaths = [...new Set(persisted.slice().reverse().flatMap((item) => item.type === "done" ? item.changedPaths : []))].slice(0, 5)

  activeRuns.set(requestId, { projectPath, sender: event.sender, runtime })
  runningProjects.add(projectPath)
  agentProcess.run({
    type: "run",
    requestId,
    projectRoot: projectPath,
    taskId: input.taskId,
    userMessage: message,
    recoveryHistory: boundedHistory,
    model,
    activeDocumentPath: input.activeDocumentPath,
    recentPaths,
    recalledHistory,
  })
  return { requestId }
})

ipcMain.handle("agent:cancel", (_event, requestId: string) => {
  if (!activeRuns.has(requestId)) return { cancelled: false }
  agentProcess.cancel(requestId)
  return { cancelled: true }
})

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    agentProcess.close()
    app.quit()
  }
})
