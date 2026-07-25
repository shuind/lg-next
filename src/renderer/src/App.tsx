import { useEffect, useRef, useState } from "react"
import {
  Activity,
  BarChart3,
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  Copy,
  Database,
  Eye,
  FileText,
  Files,
  FolderOpen,
  Globe2,
  History,
  Keyboard,
  Layers3,
  MessageSquare,
  Plus,
  ReceiptText,
  RefreshCw,
  Save,
  Server,
  Settings,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react"
import type {
  ApiCallRecord,
  DesktopApi,
  ModelStatus,
  ModelRecordView,
  ModelSettingsInput,
  ModelSettingsView,
  OpenedProject,
  ProjectUsageStats,
  TaskEvent,
  TextDocument,
  RelayInspection,
  RelayPackage,
  RecentProject,
  VersionCheckpoint,
} from "../../shared/contracts"
import { AgentComposer } from "./AgentComposer"
import { NovelMarkdownEditor } from "./NovelMarkdownEditor"
import { StoryScene } from "./StoryScene"
import { TopBar, type WorkspaceMode } from "./TopBar"

type Drawer = "project" | "files" | "versions" | null
type SettingsTab = "overview" | "models" | "apiCalls" | "preferences"
type UiPreferences = {
  enterToSend: boolean
  showStoryDetail: boolean
  compactMode: boolean
}

const DEFAULT_PREFERENCES: UiPreferences = {
  enterToSend: true,
  showStoryDetail: true,
  compactMode: false,
}

function loadPreferences(): UiPreferences {
  try {
    return { ...DEFAULT_PREFERENCES, ...JSON.parse(window.localStorage.getItem("lg:ui-preferences") ?? "{}") as Partial<UiPreferences> }
  } catch {
    return DEFAULT_PREFERENCES
  }
}

function isChapterDocument(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/")
  return /^(章节正文|章节|正文)\//.test(normalized)
    || /(^|\/)第\d+章[^/]*\.md$/i.test(normalized)
    || /(^|\/)(正文|全文)\.md$/i.test(normalized)
}

function isVisibleProjectFile(filePath: string): boolean {
  return filePath.replaceAll("\\", "/").toLowerCase() !== "novel.md"
}

type ReadableDiffLine = { kind: "added" | "removed" | "context"; text: string }
type ReadableDiffSection = { path: string; lines: ReadableDiffLine[] }

function revisionLabel(label: string): string {
  return label === "初始版本" ? "初始状态" : label
}

function readableVersionDiff(patch: string): ReadableDiffSection[] {
  const sections: ReadableDiffSection[] = []
  let current: ReadableDiffSection | null = null
  for (const line of patch.split(/\r?\n/)) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (header) {
      current = { path: header[2], lines: [] }
      sections.push(current)
      continue
    }
    if (!current || /^(index |new file mode |deleted file mode |similarity index |--- |\+\+\+ |@@)/.test(line)) continue
    if (line.startsWith("+")) current.lines.push({ kind: "added", text: line.slice(1) })
    else if (line.startsWith("-")) current.lines.push({ kind: "removed", text: line.slice(1) })
    else if (line.startsWith(" ")) current.lines.push({ kind: "context", text: line.slice(1) })
  }
  return sections.filter((section) => section.lines.length > 0)
}

export function App(): React.JSX.Element {
  const api = window.lg
  if (!api) return <BridgeUnavailable />
  return <ConnectedApp api={api} />
}

function BridgeUnavailable(): React.JSX.Element {
  return (
    <main className="startup-error">
      <div>
        <strong>LG 本地桥接没有加载</strong>
        <p>请重启开发进程。如果问题持续存在，请查看终端中的 preload 错误。</p>
      </div>
    </main>
  )
}

function ConnectedApp({ api }: { api: DesktopApi }): React.JSX.Element {
  const platform = api.versions().platform
  const [project, setProject] = useState<OpenedProject | null>(null)
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const [mode, setMode] = useState<WorkspaceMode>("chat")
  const [drawer, setDrawer] = useState<Drawer>(null)
  const [files, setFiles] = useState<string[]>([])
  const [document, setDocument] = useState<TextDocument | null>(null)
  const [draft, setDraft] = useState("")
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle")
  const [message, setMessage] = useState("")
  const [events, setEvents] = useState<TaskEvent[]>([])
  const [streamingText, setStreamingText] = useState("")
  const [running, setRunning] = useState(false)
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null)
  const [sendError, setSendError] = useState("")
  const [model, setModel] = useState<ModelStatus>({ configured: false })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("overview")
  const [modelSettings, setModelSettings] = useState<ModelSettingsView | null>(null)
  const [usageStats, setUsageStats] = useState<ProjectUsageStats | null>(null)
  const [apiCalls, setApiCalls] = useState<ApiCallRecord[]>([])
  const [preferences, setPreferences] = useState<UiPreferences>(loadPreferences)
  const [relayOpen, setRelayOpen] = useState(false)
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([])
  const [restoring, setRestoring] = useState(true)
  const [createBookOpen, setCreateBookOpen] = useState(false)
  const [externalChange, setExternalChange] = useState(false)
  const [versions, setVersions] = useState<VersionCheckpoint[]>([])
  const [selectedVersion, setSelectedVersion] = useState<VersionCheckpoint | null>(null)
  const [versionPatch, setVersionPatch] = useState("")
  const [versionBusy, setVersionBusy] = useState(false)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const transcriptEnd = useRef<HTMLDivElement>(null)
  const documentRef = useRef<TextDocument | null>(null)
  const draftRef = useRef("")
  const activeTaskIdRef = useRef<string | null>(null)

  useEffect(() => {
    void Promise.all([api.modelStatus(), api.modelSettings()]).then(([nextModel, nextSettings]) => {
      setModel(nextModel)
      setModelSettings(nextSettings)
    })
  }, [api])

  useEffect(() => {
    window.localStorage.setItem("lg:ui-preferences", JSON.stringify(preferences))
    window.document.documentElement.dataset.density = preferences.compactMode ? "compact" : "comfortable"
  }, [preferences])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const restored = await api.restoreProject()
        if (!active) return
        if (restored) await adoptProject(restored)
        else setRecentProjects(await api.listRecentProjects())
      } catch {
        if (active) setRecentProjects(await api.listRecentProjects().catch(() => []))
      } finally {
        if (active) setRestoring(false)
      }
    })()
    return () => { active = false }
  }, [api])

  useEffect(() => {
    documentRef.current = document
    draftRef.current = draft
  }, [document, draft])

  useEffect(() => {
    activeTaskIdRef.current = activeTaskId
  }, [activeTaskId])

  useEffect(() => {
    setEvents([])
    setStreamingText("")
    setRunning(false)
    setActiveRequestId(null)
    if (!project || !activeTaskId) return

    let active = true
    void api.listTaskEvents(project.path, activeTaskId).then((history) => {
      if (active) setEvents(history)
    })
    return () => { active = false }
  }, [api, project, activeTaskId])

  useEffect(() => {
    if (!project) return
    let active = true
    const unsubscribe = api.onAgentEvent((event) => {
      if (!active || event.taskId !== activeTaskIdRef.current) return
      if (event.type === "assistant_delta") {
        setStreamingText((current) => current + event.text)
        return
      }
      if (event.type === "assistant_message") setStreamingText("")
      if (event.type === "done" || event.type === "error" || event.type === "cancelled") setRunning(false)
      if (event.type === "done") {
        setActiveRequestId(null)
        void api.listMarkdown(project.path).then(setFiles)
        const currentDocument = documentRef.current
        if (currentDocument) {
          void api.readText(project.path, currentDocument.path).then((latest) => {
            if (latest.revision === currentDocument.revision) return
            if (draftRef.current === currentDocument.content) {
              setDocument(latest)
              setDraft(latest.content)
              setExternalChange(false)
            } else {
              setExternalChange(true)
            }
          }).catch(() => setExternalChange(true))
        }
      }
      setEvents((current) => {
        const index = current.findIndex((item) => item.id === event.id)
        if (index < 0) return [...current, event]
        return current.map((item, itemIndex) => itemIndex === index ? event : item)
      })
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [api, project])

  useEffect(() => {
    const transcript = transcriptRef.current
    if (!transcript) return
    transcript.scrollTo({ top: transcript.scrollHeight, behavior: running ? "smooth" : "auto" })
  }, [events, streamingText, running])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.key === "\\") {
        event.preventDefault()
        setDrawer((current) => current === "project" ? null : "project")
      } else if (event.key === ",") {
        event.preventDefault()
        void openSettings("overview")
      } else if (event.key.toLowerCase() === "s" && mode === "writing") {
        event.preventDefault()
        void saveDocument()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  })

  useEffect(() => {
    if (!project || !document || draft === document.content || externalChange || saveState === "saving" || saveState === "error") return
    const timer = window.setTimeout(() => { void saveDocument() }, 1600)
    return () => window.clearTimeout(timer)
  }, [project, document, draft, externalChange, saveState])

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent): void {
      if (!document || draft === document.content) return
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", beforeUnload)
    return () => window.removeEventListener("beforeunload", beforeUnload)
  }, [document, draft])

  async function refreshFiles(projectPath = project?.path): Promise<string[]> {
    if (!projectPath) return []
    const nextFiles = await api.listMarkdown(projectPath)
    setFiles(nextFiles)
    return nextFiles
  }

  async function adoptProject(next: OpenedProject): Promise<void> {
    setProject(next)
    const nextTaskId = next.tasks[0]?.id ?? null
    activeTaskIdRef.current = nextTaskId
    setActiveTaskId(nextTaskId)
    setDocument(null)
    setDraft("")
    setMode("chat")
    setDrawer(null)
    setExternalChange(false)
    setFiles(next.files)
    setRecentProjects(await api.listRecentProjects())
  }

  async function createBook(title: string): Promise<boolean> {
    const next = await api.createProject(title)
    if (!next) return false
    await adoptProject(next)
    return true
  }

  async function chooseProject(): Promise<void> {
    if (document && draft !== document.content && !window.confirm("当前文稿还有未保存内容。放弃这些内容并切换作品？")) return
    const next = await api.openProject()
    if (next) await adoptProject(next)
  }

  async function chooseRecentProject(projectPath: string): Promise<void> {
    if (document && draft !== document.content && !window.confirm("当前文稿还有未保存内容。放弃这些内容并切换作品？")) return
    await adoptProject(await api.openRecentProject(projectPath))
  }

  async function createTask(): Promise<void> {
    if (!project) return
    const task = await api.createTask(project.path, "新任务")
    setProject({ ...project, tasks: [task, ...project.tasks] })
    activeTaskIdRef.current = task.id
    setActiveTaskId(task.id)
    setMode("chat")
    setDrawer(null)
  }

  async function openDocument(path: string): Promise<void> {
    if (!project) return
    if (document && document.path !== path && draft !== document.content && !window.confirm("当前文稿还有未保存内容。放弃这些内容并打开其他内容？")) return
    const next = await api.readText(project.path, path)
    setDocument(next)
    setDraft(next.content)
    setSaveState("idle")
    setExternalChange(false)
    setMode("writing")
    setDrawer(null)
  }

  async function createChapter(): Promise<void> {
    if (!project) return
    const numbers = files.map((file) => /^(?:章节正文|章节)\/第(\d+)章\.md$/i.exec(file)?.[1]).filter(Boolean).map(Number)
    let number = Math.max(0, ...numbers) + 1
    let relativePath = `章节正文/第${String(number).padStart(3, "0")}章.md`
    while (files.includes(relativePath)) {
      number += 1
      relativePath = `章节正文/第${String(number).padStart(3, "0")}章.md`
    }
    await api.writeText({
      projectPath: project.path,
      relativePath,
      content: `# 第${number}章\n\n`,
      checkpointLabel: `新建 ${relativePath}`,
    })
    await refreshFiles()
    await openDocument(relativePath)
  }

  async function openWriting(): Promise<void> {
    if (document && isChapterDocument(document.path)) {
      setMode("writing")
      return
    }
    const nextFiles = files.length ? files : await refreshFiles()
    const first = nextFiles.find(isChapterDocument)
    if (first) await openDocument(first)
    else {
      setDocument(null)
      setDraft("")
      setMode("writing")
    }
  }

  async function saveDocument(): Promise<void> {
    if (!project || !document || draft === document.content || saveState === "saving" || externalChange) return
    setSaveState("saving")
    try {
      const saved = await api.writeText({
        projectPath: project.path,
        relativePath: document.path,
        content: draft,
        expectedRevision: document.revision,
        checkpointLabel: `编辑 ${document.path}`,
      })
      setDocument(saved)
      setDraft(saved.content)
      setSaveState("saved")
      window.setTimeout(() => setSaveState("idle"), 1400)
    } catch {
      setSaveState("error")
    }
  }

  async function reloadDocument(): Promise<void> {
    if (!project || !document) return
    const latest = await api.readText(project.path, document.path)
    setDocument(latest)
    setDraft(latest.content)
    setExternalChange(false)
    setSaveState("idle")
  }

  async function openSettings(tab: SettingsTab = "overview"): Promise<void> {
    setSettingsTab(tab)
    setSettingsOpen(true)
    const [nextSettings, nextUsage, nextApiCalls] = await Promise.all([
      api.modelSettings(),
      api.projectUsage(project?.path),
      api.apiCallRecords(project?.path, 200),
    ])
    setModelSettings(nextSettings)
    setUsageStats(nextUsage)
    setApiCalls(nextApiCalls)
  }

  async function switchModel(modelName: string): Promise<void> {
    const current = modelSettings ?? await api.modelSettings()
    const active = current.records.find((record) => record.id === current.activeRecordId)
    if (!active) return
    const nextSettings = await api.saveModelSettings({
      id: active.id,
      name: active.name,
      provider: active.provider,
      baseUrl: active.baseUrl,
      model: modelName,
      pricing: active.pricing,
    })
    const nextModel = await api.modelStatus()
    setModelSettings(nextSettings)
    setModel(nextModel)
  }

  async function openVersions(): Promise<void> {
    if (!project) return
    setDrawer("versions")
    setVersionBusy(true)
    try {
      const history = await api.listVersions(project.path, 50)
      setVersions(history)
      if (history[0]) await selectVersion(history[0])
    } finally { setVersionBusy(false) }
  }

  async function selectVersion(version: VersionCheckpoint): Promise<void> {
    if (!project) return
    setSelectedVersion(version)
    setVersionPatch("")
    const result = await api.versionDiff(project.path, version.commit)
    setVersionPatch(result.patch)
  }

  async function restoreSelectedVersion(): Promise<void> {
    if (!project || !selectedVersion || versionBusy) return
    if (!window.confirm(`恢复到“${revisionLabel(selectedVersion.label)}”？\n\n当前作品会先自动保存为一条新修订，任务对话不会回退。`)) return
    setVersionBusy(true)
    try {
      await api.restoreVersion(project.path, selectedVersion.commit, selectedVersion.label)
      const nextFiles = await refreshFiles()
      if (document) {
        if (nextFiles.includes(document.path)) await openDocument(document.path)
        else { setDocument(null); setDraft(""); setMode("chat") }
      }
      const history = await api.listVersions(project.path, 50)
      setVersions(history)
      if (history[0]) await selectVersion(history[0])
    } finally { setVersionBusy(false) }
  }

  async function sendMessage(): Promise<void> {
    if (!project || !message.trim() || running) return
    const nextMessage = message.trim()
    setMessage("")
    setSendError("")
    setRunning(true)
    try {
      let taskId = activeTaskIdRef.current
      if (!taskId) {
        const task = await api.createTask(project.path, nextMessage.slice(0, 24) || "新任务")
        taskId = task.id
        activeTaskIdRef.current = task.id
        setActiveTaskId(task.id)
        setProject((current) => current ? { ...current, tasks: [task, ...current.tasks] } : current)
      }
      const result = await api.runAgent({ projectPath: project.path, taskId, message: nextMessage, activeDocumentPath: document?.path })
      setActiveRequestId(result.requestId)
    } catch (error) {
      setRunning(false)
      setMessage(nextMessage)
      setSendError(error instanceof Error ? error.message : String(error))
    }
  }

  async function cancelAgent(): Promise<void> {
    if (!activeRequestId) return
    await api.cancelAgent(activeRequestId)
  }

  const activeTask = project?.tasks.find((task) => task.id === activeTaskId)
  const dirty = Boolean(document && draft !== document.content)
  return (
    <main className={`focused-shell platform-${platform}`}>
      <TopBar
        mode={mode}
        projectName={project?.name}
        projectOpen={Boolean(project)}
        projectPanelOpen={drawer === "project"}
        filesPanelOpen={drawer === "files"}
        versionsPanelOpen={drawer === "versions"}
        onToggleProject={() => setDrawer(drawer === "project" ? null : "project")}
        onOpenChat={() => setMode("chat")}
        onOpenWriting={() => void openWriting()}
        onToggleFiles={() => {
          void refreshFiles()
          setDrawer(drawer === "files" ? null : "files")
        }}
        onOpenVersions={() => void openVersions()}
        onOpenSettings={() => void openSettings("overview")}
      />

      <section className="workspace-stage">
        <div className="main-column">
          {mode === "chat" ? (
            <ChatWorkspace
              project={project}
              activeTaskTitle={activeTask?.title}
              events={events}
              streamingText={streamingText}
              running={running}
              model={model}
              modelOptions={modelSettings?.recentModels ?? []}
              message={message}
              sendError={sendError}
              transcriptRef={transcriptRef}
              transcriptEnd={transcriptEnd}
              onMessageChange={setMessage}
              onSend={() => void sendMessage()}
              onCancel={() => void cancelAgent()}
              onOpenProject={() => void chooseProject()}
              onCreateProject={() => setCreateBookOpen(true)}
              onOpenRelay={() => setRelayOpen(true)}
              onOpenSettings={() => void openSettings("models")}
              onSelectModel={switchModel}
              onOpenFile={(path) => void openDocument(path)}
              libraryLoading={restoring}
              enterToSend={preferences.enterToSend}
              showStoryDetail={preferences.showStoryDetail}
            />
          ) : (
            <WritingWorkspace
              document={document}
              draft={draft}
              dirty={dirty}
              saveState={saveState}
              externalChange={externalChange}
              onDraftChange={(value) => {
                setDraft(value)
                setSaveState("idle")
              }}
              onSave={() => void saveDocument()}
              onOpenFiles={() => setDrawer("files")}
              onCreateChapter={() => void createChapter()}
              onReload={() => void reloadDocument()}
            />
          )}
        </div>

        {drawer && <button className="drawer-scrim" aria-label="关闭面板" onClick={() => setDrawer(null)} />}

        <aside className={`drawer drawer-left ${drawer === "project" ? "open" : ""}`} aria-hidden={drawer !== "project"}>
          <DrawerHeader icon={<BookOpen size={16} />} title="项目导航" onClose={() => setDrawer(null)} />
          <div className="drawer-body project-panel">
            <button className="open-project-card" onClick={() => void chooseProject()}>
              <FolderOpen size={19} />
              <span><strong>{project?.name ?? "打开一本书"}</strong><small>{project?.path ?? "选择作品所在的文件夹"}</small></span>
            </button>
            <button className="new-project-link" onClick={() => { setDrawer(null); setCreateBookOpen(true) }}><Plus size={14} />新建一本书</button>
            <div className="panel-heading"><span>对话任务</span><button disabled={!project || running} onClick={() => void createTask()} title="新任务"><Plus size={15} /></button></div>
            <nav className="panel-list">
              {(project?.tasks ?? []).map((task) => (
                <button key={task.id} disabled={running && task.id !== activeTaskId} className={task.id === activeTaskId ? "active" : ""} onClick={() => {
                  activeTaskIdRef.current = task.id
                  setActiveTaskId(task.id)
                  setMode("chat")
                  setDrawer(null)
                }}>
                  <MessageSquare size={14} /><span>{task.title}</span>
                </button>
              ))}
            </nav>
            {recentProjects.length > 0 && <div className="panel-heading recent-heading"><span>最近作品</span></div>}
            <nav className="panel-list recent-list">
              {recentProjects.filter((recent) => recent.path !== project?.path).map((recent) => (
                <button key={recent.path} onClick={() => void chooseRecentProject(recent.path)}>
                  <BookOpen size={14} /><span><strong>{recent.name}</strong><small>{recent.path}</small></span>
                </button>
              ))}
            </nav>
          </div>
        </aside>

        <aside className={`drawer drawer-right ${drawer === "files" ? "open" : ""}`} aria-hidden={drawer !== "files"}>
          <DrawerHeader icon={<Files size={16} />} title="作品目录" onClose={() => setDrawer(null)} />
          <div className="drawer-body">
            <div className="file-root"><BookOpen size={15} /><span>{project?.name ?? "未打开作品"}</span><button disabled={!project} onClick={() => void createChapter()} title="新建章节"><Plus size={14} /></button></div>
            <nav className="file-list">
              {files.filter(isVisibleProjectFile).map((file) => (
                <button key={file} className={document?.path === file ? "active" : ""} onClick={() => void openDocument(file)}>
                  <span>{file}</span>
                </button>
              ))}
              {project && files.filter(isVisibleProjectFile).length === 0 && <p className="panel-empty">还没有正文或项目资料。</p>}
            </nav>
          </div>
        </aside>

        <aside className={`drawer drawer-right versions-drawer ${drawer === "versions" ? "open" : ""}`} aria-hidden={drawer !== "versions"}>
          <DrawerHeader icon={<History size={16} />} title="修订记录" onClose={() => setDrawer(null)} />
          <div className="version-workspace">
            <nav className="version-list">
              {versions.map((version) => (
                <button key={version.commit} className={selectedVersion?.commit === version.commit ? "active" : ""} onClick={() => void selectVersion(version)}>
                  <strong>{revisionLabel(version.label)}</strong>
                  <small>{new Date(version.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small>
                  {version.label !== "初始版本" && version.files.length > 0 && <span>{version.files.map((file) => file.path).slice(0, 2).join("、")}</span>}
                </button>
              ))}
              {!versionBusy && versions.length === 0 && <p className="panel-empty">还没有修订记录。</p>}
            </nav>
            <section className="version-detail">
              {selectedVersion ? <>
              <header><div><strong>{revisionLabel(selectedVersion.label)}</strong><small>{new Date(selectedVersion.createdAt).toLocaleString("zh-CN")}</small></div><button disabled={versionBusy} onClick={() => void restoreSelectedVersion()}>恢复到这里</button></header>
                {selectedVersion.label !== "初始版本" && selectedVersion.files.length > 0 && <div className="changed-files">{selectedVersion.files.map((file) => <span key={`${file.status}:${file.path}`}>{file.path}</span>)}</div>}
                {selectedVersion.label === "初始版本" ? <div className="version-empty" /> : <VersionChanges patch={versionPatch} />}
            </> : <div className="version-placeholder">选择一条修订查看改动。</div>}
            </section>
          </div>
        </aside>
      </section>
      {settingsOpen && modelSettings && usageStats && (
        <SettingsCenter
          key={settingsTab}
          api={api}
          initial={modelSettings}
          initialTab={settingsTab}
          stats={usageStats}
          initialApiCalls={apiCalls}
          projectPath={project?.path}
          preferences={preferences}
          onPreferencesChange={setPreferences}
          onClose={() => setSettingsOpen(false)}
          onSaved={async () => {
            setModel(await api.modelStatus())
            setModelSettings(await api.modelSettings())
          }}
        />
      )}
      {createBookOpen && (
        <CreateBookModal
          onClose={() => setCreateBookOpen(false)}
          onCreate={async (title) => {
            const created = await createBook(title)
            if (created) setCreateBookOpen(false)
            return created
          }}
        />
      )}
      {relayOpen && project && activeTaskId && (
        <RelayModal
          api={api}
          project={project}
          taskId={activeTaskId}
          activeDocumentPath={document?.path}
          initialInstruction={message}
          onClose={() => setRelayOpen(false)}
          onApplied={async (paths) => {
            await refreshFiles()
            if (paths[0]) await openDocument(paths[0])
            setRelayOpen(false)
          }}
        />
      )}
    </main>
  )
}

function ChatWorkspace({
  project,
  activeTaskTitle,
  events,
  streamingText,
  running,
  model,
  modelOptions,
  message,
  sendError,
  transcriptRef,
  transcriptEnd,
  onMessageChange,
  onSend,
  onCancel,
  onOpenProject,
  onCreateProject,
  onOpenRelay,
  onOpenSettings,
  onSelectModel,
  onOpenFile,
  libraryLoading,
  enterToSend,
  showStoryDetail,
}: {
  project: OpenedProject | null
  activeTaskTitle?: string
  events: TaskEvent[]
  streamingText: string
  running: boolean
  model: ModelStatus
  modelOptions: string[]
  message: string
  sendError: string
  transcriptRef: React.RefObject<HTMLDivElement | null>
  transcriptEnd: React.RefObject<HTMLDivElement | null>
  onMessageChange(value: string): void
  onSend(): void
  onCancel(): void
  onOpenProject(): void
  onCreateProject(): void
  onOpenRelay(): void
  onOpenSettings(): void
  onSelectModel(modelName: string): Promise<void>
  onOpenFile(path: string): void
  libraryLoading: boolean
  enterToSend: boolean
  showStoryDetail: boolean
}): React.JSX.Element {
  if (!project) {
    return (
      <LibraryWorkspace
        loading={libraryLoading}
        onCreateProject={onCreateProject}
        onOpenProject={onOpenProject}
      />
    )
  }
  return (
    <section className="chat-workspace">
      <StoryScene showIllustrations={showStoryDetail} subdued={events.length > 0 || running} />
      <div className="transcript" ref={transcriptRef}>
        <div className="transcript-inner">
          {events.length === 0 && !running && <ChatEmptyState />}
          {events.map((event) => <EventView key={event.id} event={event} onOpenFile={onOpenFile} />)}
          {streamingText && <article className="agent-message streaming">{streamingText}</article>}
          {running && !streamingText && <div className="status-event pulsing">Agent 正在工作…</div>}
          <div ref={transcriptEnd} />
        </div>
      </div>
      <AgentComposer
        model={model}
        modelOptions={modelOptions}
        message={message}
        running={running}
        sendError={sendError}
        activeTaskTitle={activeTaskTitle}
        enterToSend={enterToSend}
        onMessageChange={onMessageChange}
        onSend={onSend}
        onCancel={onCancel}
        onOpenRelay={onOpenRelay}
        onOpenSettings={onOpenSettings}
        onSelectModel={onSelectModel}
      />
    </section>
  )
}

function ChatEmptyState(): React.JSX.Element {
  return <div className="chat-empty" aria-hidden="true" />
}

function LibraryWorkspace({
  loading,
  onCreateProject,
  onOpenProject,
}: {
  loading: boolean
  onCreateProject(): void
  onOpenProject(): void
}): React.JSX.Element {
  return (
    <section className="library-workspace">
      <StoryScene showIllustrations />
      <div className="library-content">
        {loading ? (
          <span className="library-loading">正在展开书页…</span>
        ) : (
          <>
            <Sparkles size={18} aria-hidden="true" />
            <p>这页还没有故事。</p>
            <div className="library-actions">
              <button onClick={onCreateProject}><Plus size={16} />新建作品</button>
              <button onClick={onOpenProject}><FolderOpen size={16} />打开作品</button>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

function CreateBookModal({
  onClose,
  onCreate,
}: {
  onClose(): void
  onCreate(title: string): Promise<boolean>
}): React.JSX.Element {
  const [title, setTitle] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function submit(): Promise<void> {
    const cleanTitle = title.trim()
    if (!cleanTitle || busy) return
    setBusy(true)
    setError("")
    try {
      await onCreate(cleanTitle)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-layer">
      <button className="modal-scrim" aria-label="关闭" onClick={onClose} />
      <form className="settings-modal create-book-modal" onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <header><div><BookOpen size={16} /><strong>新建一本书</strong></div><button type="button" onClick={onClose}><X size={16} /></button></header>
        <div className="create-book-body">
          <label htmlFor="book-title">书名</label>
          <input id="book-title" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="暂定名也可以" />
          <p>下一步只选择保存位置。LG 会创建 <code>NOVEL.md</code> 和最小元数据，不会预建章节、任务、索引或 Git。</p>
          {error && <div className="settings-error">{error}</div>}
        </div>
        <footer><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={!title.trim() || busy}>{busy ? "创建中…" : "选择位置并创建"}</button></footer>
      </form>
    </div>
  )
}

function EventView({ event, onOpenFile }: { event: TaskEvent; onOpenFile(path: string): void }): React.JSX.Element | null {
  if (event.type === "user_message") return <div className="user-message">{event.text}</div>
  if (event.type === "status") return <div className="status-event">{event.label}</div>
  if (event.type === "tool") {
    return (
      <details className={`tool-record ${event.status}`}>
        <summary><SquareTerminal size={14} /><span>{event.label}</span><span>{event.status === "running" ? "运行中" : event.status === "completed" ? "完成" : "失败"}<ChevronDown size={13} /></span></summary>
        {event.detail && <pre>{event.detail}</pre>}
      </details>
    )
  }
  if (event.type === "source") {
    return (
      <button className="source-event" onClick={() => onOpenFile(event.path)}>
        <Files size={13} />
        <span><strong>{event.path}</strong><small>{event.startLine ? `${event.startLine}-${event.endLine ?? event.startLine} 行 · ` : ""}{event.revision.slice(0, 8)}</small></span>
      </button>
    )
  }
  if (event.type === "compaction") {
    return <div className="status-event">已压缩任务上下文 · {event.tokenBefore.toLocaleString("zh-CN")} → {event.tokenAfter.toLocaleString("zh-CN")} tokens</div>
  }
  if (event.type === "cancelled") return <div className="status-event">{event.message}</div>
  if (event.type === "handoff") {
    return (
      <div className="result-card">
        <div><Globe2 size={15} /><strong>官网接力包已准备</strong></div>
        <small>{event.package.sourceCount} 个来源 · 约 {event.package.estimatedTokens.toLocaleString("zh-CN")} tokens</small>
        <button className="result-file" onClick={() => void window.lg?.copyText(event.package.content)}><Copy size={12} />复制接力包</button>
      </div>
    )
  }
  if (event.type === "assistant_message") return <article className="agent-message">{event.text}</article>
  if (event.type === "error") return <div className="error-event">{event.message}</div>
  if (event.type === "done") {
    return (
      <div className="result-card">
        <div><Check size={15} /><strong>{event.changedPaths.length ? "已完成并写入作品" : "已完成"}</strong></div>
        {event.changedPaths.map((file) => <button className="result-file" key={file} onClick={() => onOpenFile(file)}>{file}</button>)}
      </div>
    )
  }
  return null
}

function WritingWorkspace({
  document,
  draft,
  dirty,
  saveState,
  externalChange,
  onDraftChange,
  onSave,
  onOpenFiles,
  onCreateChapter,
  onReload,
}: {
  document: TextDocument | null
  draft: string
  dirty: boolean
  saveState: "idle" | "saving" | "saved" | "error"
  externalChange: boolean
  onDraftChange(value: string): void
  onSave(): void
  onOpenFiles(): void
  onCreateChapter(): void
  onReload(): void
}): React.JSX.Element {
  if (!document) {
    return <div className="writing-empty-actions"><button className="primary" onClick={onCreateChapter}><Plus size={14} />新建第一章</button><button onClick={onOpenFiles}>选择已有正文</button></div>
  }
  return (
    <section className="writing-workspace">
      <header className="writing-header">
        <div><small>正在编辑 · {draft.replace(/\s/g, "").length.toLocaleString("zh-CN")} 字</small><strong>{document.path}</strong></div>
        <button onClick={onSave} disabled={!dirty || saveState === "saving" || externalChange} className={saveState === "error" ? "save-error" : ""}>
          {saveState === "saved" ? <Check size={15} /> : <Save size={15} />}
          {saveState === "saving" ? "保存中" : saveState === "saved" ? "已保存" : saveState === "error" ? "保存失败" : dirty ? "保存" : "已保存"}
        </button>
      </header>
      {externalChange && <div className="external-change"><span>Agent 已修改磁盘上的这一章。当前编辑区有尚未保存的内容，因此没有自动覆盖。</span><button onClick={onReload}>放弃本地编辑并载入最新内容</button></div>}
      <div className="editor-scroll">
        <NovelMarkdownEditor documentKey={`${document.path}:${document.revision}`} value={draft} onChange={onDraftChange} />
      </div>
    </section>
  )
}

function DrawerHeader({ icon, title, onClose }: { icon: React.ReactNode; title: string; onClose(): void }): React.JSX.Element {
  return <header className="drawer-header"><div>{icon}<strong>{title}</strong></div><button onClick={onClose} aria-label={`关闭${title}`}><X size={16} /></button></header>
}

function VersionChanges({ patch }: { patch: string }): React.JSX.Element {
  const sections = readableVersionDiff(patch)
  if (!sections.length) return <div className="version-empty">无正文改动</div>
  return (
    <div className="version-changes">
      {sections.map((section) => (
        <article key={section.path}>
          <header>{section.path}</header>
          <div>
            {section.lines.map((line, index) => (
              <p className={line.kind} key={`${index}:${line.text}`}><i>{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : ""}</i><span>{line.text || " "}</span></p>
            ))}
          </div>
        </article>
      ))}
    </div>
  )
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value)
}

const EMPTY_MODEL_PRICING: ModelSettingsInput["pricing"] = {
  currency: "CNY",
  inputPerMillion: 0,
  outputPerMillion: 0,
  cacheReadPerMillion: 0,
  cacheWritePerMillion: 0,
}

function modelRecordForm(record: ModelRecordView): ModelSettingsInput {
  return {
    id: record.id,
    name: record.name,
    provider: record.provider,
    baseUrl: record.baseUrl,
    model: record.model,
    apiKey: "",
    pricing: { ...record.pricing },
  }
}

function newModelRecordForm(): ModelSettingsInput {
  return {
    name: "",
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "",
    apiKey: "",
    pricing: { ...EMPTY_MODEL_PRICING },
  }
}

function priceLabel(value: number, currency: ModelSettingsInput["pricing"]["currency"]): string {
  const symbol = currency === "CNY" ? "¥" : "$"
  return `${symbol}${value.toLocaleString("zh-CN", { maximumFractionDigits: 4 })}/M`
}

function ApiRequestDetails({ api, body }: { api: DesktopApi; body?: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  if (!body) return <div className="api-request-missing">旧记录没有请求快照</div>
  let formatted = body
  if (open) {
    try { formatted = JSON.stringify(JSON.parse(body) as unknown, null, 2) } catch { formatted = body }
  }
  return (
    <details className="api-request-body" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary><span>完整请求</span><small>{body.length.toLocaleString("zh-CN")} 字符 · 不含 API Key</small></summary>
      {open && <div><button onClick={() => void api.copyText(formatted)}><Copy size={11} />复制 JSON</button><pre>{formatted}</pre></div>}
    </details>
  )
}

function SettingsCenter({
  api,
  initial,
  initialTab,
  stats,
  initialApiCalls,
  projectPath,
  preferences,
  onPreferencesChange,
  onClose,
  onSaved,
}: {
  api: DesktopApi
  initial: ModelSettingsView
  initialTab: SettingsTab
  stats: ProjectUsageStats
  initialApiCalls: ApiCallRecord[]
  projectPath?: string
  preferences: UiPreferences
  onPreferencesChange(value: UiPreferences): void
  onClose(): void
  onSaved(): Promise<void>
}): React.JSX.Element {
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  const initialRecord = initial.records.find((record) => record.id === initial.activeRecordId) ?? initial.records[0]
  const [settings, setSettings] = useState(initial)
  const [selectedRecordId, setSelectedRecordId] = useState(initialRecord?.id ?? "new")
  const [form, setForm] = useState<ModelSettingsInput>(() => initialRecord ? modelRecordForm(initialRecord) : newModelRecordForm())
  const [busy, setBusy] = useState<"save" | "test" | null>(null)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const [calls, setCalls] = useState(initialApiCalls)
  const [callsBusy, setCallsBusy] = useState(false)
  const maxDailyRuns = Math.max(1, ...stats.daily.map((item) => item.runs))

  function update(field: "name" | "provider" | "baseUrl" | "model" | "apiKey", value: string): void {
    setForm((current) => ({ ...current, [field]: value }))
    setMessage("")
    setError("")
  }

  function updatePrice(field: keyof ModelSettingsInput["pricing"], value: string): void {
    setForm((current) => ({
      ...current,
      pricing: {
        ...current.pricing,
        [field]: field === "currency" ? value : Math.max(0, Number(value) || 0),
      },
    }))
    setMessage("")
    setError("")
  }

  function selectRecord(record: ModelRecordView): void {
    setSelectedRecordId(record.id)
    setForm(modelRecordForm(record))
    setMessage("")
    setError("")
  }

  function addRecord(): void {
    setSelectedRecordId("new")
    setForm(newModelRecordForm())
    setMessage("")
    setError("")
  }

  async function save(): Promise<void> {
    setBusy("save"); setError("")
    try {
      const next = await api.saveModelSettings(form)
      const active = next.records.find((record) => record.id === next.activeRecordId)
      setSettings(next)
      if (active) {
        setSelectedRecordId(active.id)
        setForm(modelRecordForm(active))
      }
      await onSaved()
      setMessage("API 记录已保存，并设为当前连接。")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(null) }
  }

  async function activate(): Promise<void> {
    if (selectedRecordId === "new") return
    setBusy("save"); setError("")
    try {
      const next = await api.activateModelRecord(selectedRecordId)
      setSettings(next)
      await onSaved()
      setMessage("已切换为当前连接。")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(null) }
  }

  async function remove(): Promise<void> {
    if (selectedRecordId === "new" || form.id === "environment") return
    if (!window.confirm(`删除 API 记录“${form.name}”？此操作不会删除任何作品。`)) return
    setBusy("save"); setError("")
    try {
      const next = await api.deleteModelRecord(selectedRecordId)
      const active = next.records.find((record) => record.id === next.activeRecordId) ?? next.records[0]
      setSettings(next)
      setSelectedRecordId(active?.id ?? "new")
      setForm(active ? modelRecordForm(active) : newModelRecordForm())
      await onSaved()
      setMessage("API 记录已删除。")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(null) }
  }

  async function refreshCalls(): Promise<void> {
    if (!projectPath) return
    setCallsBusy(true)
    try {
      setCalls(await api.apiCallRecords(projectPath, 200))
    } finally {
      setCallsBusy(false)
    }
  }

  async function test(): Promise<void> {
    setBusy("test"); setError("")
    try {
      const result = await api.testModel(form)
      setMessage(`连接成功 · ${result.latencyMs} ms · ${result.reply}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(null) }
  }

  return (
    <div className="modal-layer settings-layer" role="dialog" aria-modal="true" aria-label="设置">
      <button className="modal-scrim" onClick={onClose} aria-label="关闭设置" />
      <section className="settings-center">
        <aside className="settings-sidebar">
          <div className="settings-brand"><span><Layers3 size={17} /></span><div><strong>LG Next</strong><small>设置</small></div></div>
          <nav>
            <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}><BarChart3 size={15} />使用概览</button>
            <button className={tab === "models" ? "active" : ""} onClick={() => setTab("models")}><Server size={15} />API 管理</button>
            <button className={tab === "apiCalls" ? "active" : ""} onClick={() => setTab("apiCalls")}><ReceiptText size={15} />调用记录</button>
            <button className={tab === "preferences" ? "active" : ""} onClick={() => setTab("preferences")}><SlidersHorizontal size={15} />界面偏好</button>
          </nav>
          <div className="settings-local-note"><Database size={14} /><span>作品与记录保存在本地</span></div>
        </aside>

        <div className="settings-main">
          <header className="settings-titlebar">
            <div>
              <strong>{tab === "overview" ? "使用概览" : tab === "models" ? "API 管理" : tab === "apiCalls" ? "调用记录" : "界面偏好"}</strong>
              <small>{tab === "overview" ? (stats.projectName ?? "尚未打开作品") : tab === "models" ? `${settings.records.length} 条记录 · 当前连接单独生效` : tab === "apiCalls" ? "每一次真实模型请求，按新到旧排列" : "只影响这台设备"}</small>
            </div>
            <button onClick={onClose} aria-label="关闭设置"><X size={17} /></button>
          </header>

          {tab === "overview" && (
            <div className="settings-scroll overview-panel">
              <section className="usage-hero">
                <div><span className="section-kicker"><Activity size={13} />当前作品</span><h2>{stats.projectName ?? "打开一本书后查看使用记录"}</h2><p>{stats.lastActiveAt ? `最近活动于 ${new Date(stats.lastActiveAt).toLocaleString("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "所有统计都来自本地任务记录。"}</p></div>
                <span className="local-badge"><Database size={12} />本地统计</span>
              </section>
              <div className="usage-cards">
                <article><FileText size={16} /><span>正文字数</span><strong>{formatCompactNumber(stats.characterCount)}</strong><small>不含作品清单</small></article>
                <article><Bot size={16} /><span>Agent 任务</span><strong>{formatCompactNumber(stats.runCount)}</strong><small>{stats.taskCount} 个对话</small></article>
                <article><Sparkles size={16} /><span>模型用量</span><strong>{formatCompactNumber(stats.totalTokens)}</strong><small>tokens</small></article>
                <article><Activity size={16} /><span>活跃天数</span><strong>{formatCompactNumber(stats.activeDayCount)}</strong><small>累计记录</small></article>
              </div>
              <section className="usage-chart-card">
                <header><div><strong>最近 14 天</strong><small>每日完成的 Agent 任务</small></div><span>{stats.daily.reduce((sum, item) => sum + item.runs, 0)} 次</span></header>
                <div className="usage-chart">
                  {stats.daily.map((item, index) => (
                    <div className="usage-day" key={item.date} title={`${item.date} · ${item.runs} 次 · ${item.tokens.toLocaleString("zh-CN")} tokens`}>
                      <i style={{ height: `${Math.max(5, Math.round(item.runs / maxDailyRuns * 100))}%` }} className={item.runs ? "active" : ""} />
                      {(index === 0 || index === 6 || index === 13) && <small>{new Date(`${item.date}T00:00:00`).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</small>}
                    </div>
                  ))}
                </div>
              </section>
              <section className="usage-detail-card">
                <header><strong>记录明细</strong><small>随任务日志实时累计</small></header>
                <div><span>对话消息</span><strong>{stats.messageCount.toLocaleString("zh-CN")}</strong></div>
              <div><span>修改过的文稿</span><strong>{stats.changedFileCount.toLocaleString("zh-CN")}</strong></div>
                <div><span>输入 tokens</span><strong>{stats.promptTokens.toLocaleString("zh-CN")}</strong></div>
                <div><span>输出 tokens</span><strong>{stats.completionTokens.toLocaleString("zh-CN")}</strong></div>
              </section>
            </div>
          )}

          {tab === "models" && (
            <div className="settings-scroll model-settings-panel">
              <header className="api-record-heading">
                <div><strong>中转站与模型</strong><small>每条记录独立保存 Key、模型和计费价格</small></div>
                <button onClick={addRecord}><Plus size={13} />新增 API</button>
              </header>
              <div className="api-record-workspace">
                <aside className="api-record-list" aria-label="API 记录列表">
                  {settings.records.map((record) => (
                    <button className={selectedRecordId === record.id ? "selected" : ""} key={record.id} onClick={() => selectRecord(record)}>
                      <span className={`connection-dot ${record.hasApiKey ? "online" : ""}`} />
                      <span className="api-record-copy">
                        <span><strong>{record.name}</strong>{settings.activeRecordId === record.id && <em>当前</em>}</span>
                        <small>{record.model}</small>
                        <small>{record.baseUrl.replace(/^https?:\/\//, "")}</small>
                        <span className="api-price-summary">
                          <i>入 {priceLabel(record.pricing.inputPerMillion, record.pricing.currency)}</i>
                          <i>出 {priceLabel(record.pricing.outputPerMillion, record.pricing.currency)}</i>
                          <i>缓存 {priceLabel(record.pricing.cacheReadPerMillion, record.pricing.currency)}</i>
                        </span>
                      </span>
                    </button>
                  ))}
                  {settings.records.length === 0 && <div className="api-record-empty"><Server size={18} /><span>还没有 API 记录</span><small>新增一条即可开始使用</small></div>}
                </aside>

                <section className="api-record-editor">
                  <header>
                    <div><strong>{selectedRecordId === "new" ? "新增 API 记录" : form.name || "未命名记录"}</strong><small>{form.id === "environment" ? "来自环境变量；保存后会复制到本机" : "Key 仅保存在当前设备"}</small></div>
                    {selectedRecordId !== "new" && form.id !== "environment" && <button className="danger-icon" onClick={() => void remove()} title="删除此记录" aria-label="删除此记录"><Trash2 size={14} /></button>}
                  </header>
                  <div className="api-form-grid">
                    <label><span>记录名称</span><input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="例如：硅基流动主站" /></label>
                    <label><span>提供方</span><input value={form.provider} onChange={(event) => update("provider", event.target.value)} placeholder="openai-compatible" /></label>
                    <label className="wide"><span>Base URL</span><input value={form.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://api.example.com/v1" /></label>
                    <label className="wide"><span>API Key</span><input type="password" value={form.apiKey} onChange={(event) => update("apiKey", event.target.value)} placeholder={form.id ? "已保存；留空保持不变" : "输入 API Key"} /></label>
                    <label className="wide"><span>模型 ID</span><input value={form.model} onChange={(event) => update("model", event.target.value)} placeholder="deepseek-chat" /></label>
                  </div>
                  <div className="api-pricing-section">
                    <header><div><strong>价格</strong><small>每百万 tokens，仅用于本地成本参考</small></div><select value={form.pricing.currency} onChange={(event) => updatePrice("currency", event.target.value)}><option value="CNY">人民币 CNY</option><option value="USD">美元 USD</option></select></header>
                    <div>
                      <label><span>输入</span><input type="number" min="0" step="0.0001" value={form.pricing.inputPerMillion} onChange={(event) => updatePrice("inputPerMillion", event.target.value)} /></label>
                      <label><span>输出</span><input type="number" min="0" step="0.0001" value={form.pricing.outputPerMillion} onChange={(event) => updatePrice("outputPerMillion", event.target.value)} /></label>
                      <label><span>缓存读取</span><input type="number" min="0" step="0.0001" value={form.pricing.cacheReadPerMillion} onChange={(event) => updatePrice("cacheReadPerMillion", event.target.value)} /></label>
                      <label><span>缓存写入</span><input type="number" min="0" step="0.0001" value={form.pricing.cacheWritePerMillion} onChange={(event) => updatePrice("cacheWritePerMillion", event.target.value)} /></label>
                    </div>
                    <p>缓存是否命中由 API 服务商决定；这里记录服务商的缓存计费单价。</p>
                  </div>
                  {message && <div className="settings-success">{message}</div>}
                  {error && <div className="settings-error">{error}</div>}
                  <footer className="api-record-actions">
                    <button onClick={() => void test()} disabled={Boolean(busy)}>{busy === "test" ? "测试中…" : "测试连接"}</button>
                    {selectedRecordId !== "new" && settings.activeRecordId !== selectedRecordId && form.id !== "environment" && <button onClick={() => void activate()} disabled={Boolean(busy)}>设为当前</button>}
                    <button className="primary" onClick={() => void save()} disabled={Boolean(busy)}>{busy === "save" ? "保存中…" : form.id === "environment" ? "保存到本机并使用" : "保存并使用"}</button>
                  </footer>
                </section>
              </div>
            </div>
          )}

          {tab === "apiCalls" && (
            <div className="settings-scroll api-call-panel">
              <header className="api-call-toolbar">
                <div><strong>API 调用流水</strong><small>{projectPath ? `当前作品 · 最近 ${calls.length} 条` : "打开作品后显示调用记录"}</small></div>
                <button onClick={() => void refreshCalls()} disabled={!projectPath || callsBusy}><RefreshCw size={12} className={callsBusy ? "spinning" : ""} />刷新</button>
              </header>
              {calls.length > 0 ? <>
                <div className="api-call-summary">
                  <article><span>请求次数</span><strong>{calls.length}</strong></article>
                  <article><span>输入 tokens</span><strong>{formatCompactNumber(calls.reduce((sum, call) => sum + call.inputTokens, 0))}</strong></article>
                  <article><span>输出 tokens</span><strong>{formatCompactNumber(calls.reduce((sum, call) => sum + call.outputTokens, 0))}</strong></article>
                  <article><span>缓存命中</span><strong>{formatCompactNumber(calls.reduce((sum, call) => sum + call.cachedInputTokens, 0))}</strong></article>
                </div>
                <div className="api-call-list">
                  <div className="api-call-columns"><span>时间 / 状态</span><span>站点 / 模型</span><span>Token 明细</span><span>延迟 / 费用</span></div>
                  {calls.map((call) => (
                    <article className={call.status} key={call.id} title={call.error}>
                      <div><strong>{new Date(call.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</strong><small><i />{call.status === "succeeded" ? "成功" : "失败"} · {call.kind === "compaction" ? "上下文压缩" : call.kind === "final" ? "收尾请求" : "Agent 请求"}</small></div>
                      <div><strong>{call.recordName || call.provider}</strong><small>{call.model}</small><small>{call.baseUrl.replace(/^https?:\/\//, "")}</small></div>
                      <div className="api-token-detail"><span>输入 <b>{call.inputTokens.toLocaleString("zh-CN")}</b></span><span>输出 <b>{call.outputTokens.toLocaleString("zh-CN")}</b></span><span>缓存读 <b>{call.cachedInputTokens.toLocaleString("zh-CN")}</b></span><span>缓存写 <b>{call.cacheWriteInputTokens.toLocaleString("zh-CN")}</b></span></div>
                      <div className="api-call-charge"><strong>{call.latencyMs.toLocaleString("zh-CN")} ms</strong><small>{call.cost === undefined || !call.currency ? "未配置价格" : `${call.currency === "CNY" ? "¥" : "$"}${call.cost.toFixed(6)}`}</small></div>
                      <ApiRequestDetails api={api} body={call.requestBody} />
                    </article>
                  ))}
                </div>
              </> : <div className="api-call-empty"><ReceiptText size={25} /><strong>{projectPath ? "还没有 API 调用记录" : "尚未打开作品"}</strong><span>{projectPath ? "下一次 Agent 请求会按实际 API 调用逐条记录在这里。" : "调用记录跟随作品保存在本地。"}</span></div>}
            </div>
          )}

          {tab === "preferences" && (
            <div className="settings-scroll preferences-panel">
              <section><header><Keyboard size={16} /><div><strong>输入与发送</strong><small>选择你习惯的换行方式</small></div></header><SettingsToggle label="Enter 直接发送" description="关闭后使用 Ctrl / Cmd + Enter 发送，Enter 只换行。" checked={preferences.enterToSend} onChange={(checked) => onPreferencesChange({ ...preferences, enterToSend: checked })} /></section>
              <section><header><Eye size={16} /><div><strong>工作区场景</strong><small>猫、屋梁与纸张细节</small></div></header><SettingsToggle label="显示场景" description="固定在对话工作区，不随消息滚动或消失。" checked={preferences.showStoryDetail} onChange={(checked) => onPreferencesChange({ ...preferences, showStoryDetail: checked })} /></section>
              <section><header><Layers3 size={16} /><div><strong>界面密度</strong><small>调整导航与控件的留白</small></div></header><SettingsToggle label="使用紧凑布局" description="缩小顶栏、面板列表和输入区的间距。" checked={preferences.compactMode} onChange={(checked) => onPreferencesChange({ ...preferences, compactMode: checked })} /></section>
              <p className="preferences-note"><Database size={13} />这些偏好只保存在当前设备，不会写入作品文件夹。</p>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function SettingsToggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange(value: boolean): void }): React.JSX.Element {
  return <button className="settings-toggle" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}><span><strong>{label}</strong><small>{description}</small></span><i className={checked ? "checked" : ""}><b /></i></button>
}

function RelayModal({
  api,
  project,
  taskId,
  activeDocumentPath,
  initialInstruction,
  onClose,
  onApplied,
}: {
  api: DesktopApi
  project: OpenedProject
  taskId: string
  activeDocumentPath?: string
  initialInstruction: string
  onClose(): void
  onApplied(paths: string[]): Promise<void>
}): React.JSX.Element {
  const [instruction, setInstruction] = useState(initialInstruction)
  const [relayPackage, setRelayPackage] = useState<RelayPackage | null>(null)
  const [response, setResponse] = useState("")
  const [inspection, setInspection] = useState<RelayInspection | null>(null)
  const [busy, setBusy] = useState<"generate" | "inspect" | "apply" | null>(null)
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")

  async function generate(): Promise<void> {
    setBusy("generate"); setError(""); setNotice(""); setInspection(null)
    try {
      const created = await api.createRelayPackage({ projectPath: project.path, taskId, instruction, activeDocumentPath })
      setRelayPackage(created)
      await api.copyText(created.content)
      setNotice(`已生成并复制 · ${created.sourceCount} 个原文片段`)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(null) }
  }

  async function copyPackage(): Promise<void> {
    if (!relayPackage) return
    await api.copyText(relayPackage.content)
    setNotice("接力包已复制到剪贴板。")
  }

  async function inspect(): Promise<void> {
    if (!relayPackage) return
    setBusy("inspect"); setError(""); setNotice("")
    try {
      setInspection(await api.inspectRelayResponse({ projectPath: project.path, sessionId: relayPackage.id, response }))
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(null) }
  }

  async function apply(): Promise<void> {
    if (!relayPackage || !inspection?.canApply) return
    setBusy("apply"); setError("")
    try {
      const result = await api.applyRelayResponse({ projectPath: project.path, sessionId: relayPackage.id, response })
      await onApplied(result.changedPaths)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(null) }
  }

  return (
    <div className="modal-layer relay-layer" role="dialog" aria-modal="true" aria-label="官网模型接力">
      <button className="modal-scrim" onClick={onClose} aria-label="关闭官网模型接力" />
      <section className="settings-modal relay-modal">
        <header><div><Globe2 size={17} /><strong>官网模型接力</strong></div><button onClick={onClose}><X size={16} /></button></header>
        <div className="relay-body">
          <section className="relay-step">
            <div className="step-title"><span>1</span><strong>生成一次性上下文包</strong></div>
            <textarea value={instruction} onChange={(event) => { setInstruction(event.target.value); setRelayPackage(null); setInspection(null) }} placeholder="告诉官网模型这一次要写什么，例如：继续当前章节。" />
            <div className="relay-actions"><small>{activeDocumentPath ? `当前目标：${activeDocumentPath}` : "未打开正文，将根据最近作品选择目标"}</small><button onClick={() => void generate()} disabled={!instruction.trim() || Boolean(busy)}>{busy === "generate" ? "生成中…" : "生成并复制"}</button></div>
            {relayPackage && <div className="package-ready"><span>{relayPackage.sourceCount} 个来源 · 约 {relayPackage.estimatedTokens.toLocaleString("zh-CN")} tokens</span><button onClick={() => void copyPackage()}><Copy size={12} />再次复制</button></div>}
          </section>

          <section className="relay-step">
            <div className="step-title"><span>2</span><strong>粘贴官网模型的完整回复</strong></div>
            <textarea className="relay-response" value={response} onChange={(event) => { setResponse(event.target.value); setInspection(null) }} disabled={!relayPackage} placeholder="官网模型完成后，把包含 <lg-write> 区块的回复粘贴到这里。" />
            <div className="relay-actions"><small>这里只预览，不会立刻写入作品。</small><button onClick={() => void inspect()} disabled={!relayPackage || !response.trim() || Boolean(busy)}>{busy === "inspect" ? "检查中…" : "检查写入内容"}</button></div>
          </section>

          {inspection && (
            <section className="relay-inspection">
              <div className="step-title"><span>3</span><strong>确认写入正式作品</strong></div>
              {inspection.message && <div className="settings-error">{inspection.message}</div>}
              {inspection.operations.map((operation, index) => (
                <div className={`relay-operation ${operation.canApply ? "valid" : "invalid"}`} key={`${operation.path}:${index}`}>
                  <div><strong>{operation.path}</strong><span>{operation.mode === "append" ? "追加" : "完整替换"} · {operation.content.length.toLocaleString("zh-CN")} 字符</span></div>
                  {operation.issue && <p>{operation.issue}</p>}
                  <pre>{operation.content.slice(0, 700)}{operation.content.length > 700 ? "\n…" : ""}</pre>
                </div>
              ))}
              <button className="apply-relay" disabled={!inspection.canApply || Boolean(busy)} onClick={() => void apply()}>{busy === "apply" ? "写入中…" : "写入作品并建立修订"}</button>
            </section>
          )}
          {notice && <div className="settings-success">{notice}</div>}
          {error && <div className="settings-error">{error}</div>}
        </div>
      </section>
    </div>
  )
}
