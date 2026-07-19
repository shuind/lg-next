import { Files, History, Library, MessageSquare, PenLine, Settings } from "lucide-react"

export type WorkspaceMode = "chat" | "writing"

export function TopBar({
  mode,
  projectName,
  projectOpen,
  projectPanelOpen,
  filesPanelOpen,
  versionsPanelOpen,
  onToggleProject,
  onOpenChat,
  onOpenWriting,
  onToggleFiles,
  onOpenVersions,
  onOpenSettings,
}: {
  mode: WorkspaceMode
  projectName?: string
  projectOpen: boolean
  projectPanelOpen: boolean
  filesPanelOpen: boolean
  versionsPanelOpen: boolean
  onToggleProject(): void
  onOpenChat(): void
  onOpenWriting(): void
  onToggleFiles(): void
  onOpenVersions(): void
  onOpenSettings(): void
}): React.JSX.Element {
  return (
    <header className="topbar">
      <nav className="topbar-left" aria-label="作品与工作区">
        <button
          className="topbar-button"
          aria-expanded={projectPanelOpen}
          onClick={onToggleProject}
          title="作品（Ctrl+\\）"
        >
          <Library size={17} />
          <span>作品</span>
        </button>
        <div className="mode-switch" aria-label="主要工作区">
          <button className={mode === "chat" ? "active" : ""} onClick={onOpenChat}>
            <MessageSquare size={16} />
            <span>对话</span>
          </button>
          <button className={mode === "writing" ? "active" : ""} disabled={!projectOpen} onClick={onOpenWriting}>
            <PenLine size={16} />
            <span>正文</span>
          </button>
        </div>
      </nav>

      <div className="workspace-title">
        {projectName && <strong>{projectName}</strong>}
      </div>

      <nav className="topbar-right" aria-label="作品工具">
        <button className="topbar-button" aria-expanded={filesPanelOpen} disabled={!projectOpen} onClick={onToggleFiles} title="目录">
          <Files size={17} />
          <span>目录</span>
        </button>
        <button className="topbar-button" aria-expanded={versionsPanelOpen} disabled={!projectOpen} onClick={onOpenVersions} title="修订">
          <History size={17} />
          <span>修订</span>
        </button>
        <button className="topbar-button" onClick={onOpenSettings} title="设置（Ctrl+,）">
          <Settings size={17} />
          <span>设置</span>
        </button>
      </nav>
    </header>
  )
}
