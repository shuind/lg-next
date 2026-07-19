import { contextBridge, ipcRenderer } from "electron"
import type { DesktopApi, OpenedProject, TaskEvent } from "../shared/contracts"

const api: DesktopApi = {
  versions: () => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
  }),
  openProject: () => ipcRenderer.invoke("project:open") as Promise<OpenedProject | null>,
  createProject: (title) => ipcRenderer.invoke("project:create", title) as Promise<OpenedProject | null>,
  restoreProject: () => ipcRenderer.invoke("project:restore") as Promise<OpenedProject | null>,
  openRecentProject: (projectPath) => ipcRenderer.invoke("project:open-recent", projectPath),
  listRecentProjects: () => ipcRenderer.invoke("project:list-recent"),
  createTask: (projectPath, title) => ipcRenderer.invoke("task:create", projectPath, title),
  listMarkdown: (projectPath) => ipcRenderer.invoke("project:list-markdown", projectPath),
  readText: (projectPath, relativePath) => ipcRenderer.invoke("project:read-text", projectPath, relativePath),
  writeText: (input) => ipcRenderer.invoke("project:write-text", input),
  listTaskEvents: (projectPath, taskId) => ipcRenderer.invoke("task:list-events", projectPath, taskId),
  runAgent: (input) => ipcRenderer.invoke("agent:run", input),
  cancelAgent: (requestId) => ipcRenderer.invoke("agent:cancel", requestId),
  onAgentEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, agentEvent: TaskEvent) => listener(agentEvent)
    ipcRenderer.on("agent:event", handler)
    return () => ipcRenderer.removeListener("agent:event", handler)
  },
  modelStatus: () => ipcRenderer.invoke("model:status"),
  modelSettings: () => ipcRenderer.invoke("model:settings"),
  saveModelSettings: (input) => ipcRenderer.invoke("model:save", input),
  testModel: (input) => ipcRenderer.invoke("model:test", input),
  projectUsage: (projectPath) => ipcRenderer.invoke("usage:project", projectPath),
  storyIndexStatus: (projectPath) => ipcRenderer.invoke("story-index:status", projectPath),
  refreshStoryIndex: (projectPath) => ipcRenderer.invoke("story-index:refresh", projectPath),
  searchStoryIndex: (projectPath, query, limit) => ipcRenderer.invoke("story-index:search", projectPath, query, limit),
  createRelayPackage: (input) => ipcRenderer.invoke("relay:create", input),
  inspectRelayResponse: (input) => ipcRenderer.invoke("relay:inspect", input),
  applyRelayResponse: (input) => ipcRenderer.invoke("relay:apply", input),
  copyText: (text) => ipcRenderer.invoke("clipboard:write", text),
  listVersions: (projectPath, limit) => ipcRenderer.invoke("version:list", projectPath, limit),
  versionDiff: (projectPath, commit) => ipcRenderer.invoke("version:diff", projectPath, commit),
  restoreVersion: (projectPath, commit, label) => ipcRenderer.invoke("version:restore", projectPath, commit, label),
}

contextBridge.exposeInMainWorld("lg", api)
