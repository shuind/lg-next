import { useLayoutEffect, useRef, useState } from "react"
import { BookOpen, Check, ChevronDown, Diamond, Feather, Paperclip, Send, Settings, Square } from "lucide-react"
import type { ModelStatus } from "../../shared/contracts"

export function AgentComposer({
  model,
  modelOptions,
  message,
  running,
  sendError,
  activeTaskTitle,
  enterToSend,
  onMessageChange,
  onSend,
  onCancel,
  onOpenRelay,
  onOpenSettings,
  onSelectModel,
}: {
  model: ModelStatus
  modelOptions: string[]
  message: string
  running: boolean
  sendError: string
  activeTaskTitle?: string
  enterToSend: boolean
  onMessageChange(value: string): void
  onSend(): void
  onCancel(): void
  onOpenRelay(): void
  onOpenSettings(): void
  onSelectModel(modelName: string): Promise<void>
}): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = "0px"
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, 56), 150)
    textarea.style.height = `${nextHeight}px`
    textarea.style.overflowY = textarea.scrollHeight > 150 ? "auto" : "hidden"
  }, [message])

  const sendDisabled = running ? false : !model.configured || !message.trim()

  return (
    <footer className="composer-area">
      <div className="composer-fold" aria-hidden="true">
        <span className="composer-fold-sheet composer-fold-sheet-back" />
        <span className="composer-fold-sheet composer-fold-sheet-middle" />
        <span className="composer-fold-sheet composer-fold-sheet-front" />
      </div>
      <div className="composer-card">
        <Paperclip className="composer-clip" size={18} aria-hidden="true" />
        <div className="composer-input-row">
          <Feather className="composer-prompt-icon" size={16} aria-hidden="true" />
          <textarea
            ref={textareaRef}
            aria-label="给 Agent 的创作指令"
            value={message}
            onChange={(event) => onMessageChange(event.target.value)}
            placeholder="描述你想创作的故事、新设，或只是一段灵感的开始……"
            rows={1}
            onKeyDown={(event) => {
              const shouldSend = enterToSend
                ? event.key === "Enter" && !event.shiftKey
                : event.key === "Enter" && (event.ctrlKey || event.metaKey)
              if (!shouldSend) return
              event.preventDefault()
              if (!running) onSend()
            }}
          />
        </div>
        <div className="composer-footer">
          <button className="round-quiet" title="官网模型接力" onClick={onOpenRelay} disabled={!activeTaskTitle}>
            <Diamond size={12} />
          </button>
          <ModelPicker
            model={model}
            options={modelOptions}
            disabled={running}
            onSelect={onSelectModel}
            onOpenSettings={onOpenSettings}
          />
          <span className="composer-hint">{enterToSend ? "Enter 发送" : "Ctrl + Enter 发送"}</span>
          <button
            className="send-button"
            disabled={sendDisabled}
            onClick={running ? onCancel : onSend}
            title={running ? "停止 Agent" : "发送"}
            aria-label={running ? "停止 Agent" : "发送"}
          >
            {running ? <Square size={14} fill="currentColor" /> : <Send size={17} />}
          </button>
        </div>
        {sendError && <div className="composer-error">{sendError}</div>}
      </div>
    </footer>
  )
}

function ModelPicker({
  model,
  options,
  disabled,
  onSelect,
  onOpenSettings,
}: {
  model: ModelStatus
  options: string[]
  disabled: boolean
  onSelect(modelName: string): Promise<void>
  onOpenSettings(): void
}): React.JSX.Element {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const [customModel, setCustomModel] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const choices = [...new Set([model.model, ...options].filter((item): item is string => Boolean(item)))]

  async function select(modelName: string): Promise<void> {
    if (!modelName.trim() || busy || modelName === model.model) {
      detailsRef.current?.removeAttribute("open")
      return
    }
    setBusy(true)
    setError("")
    try {
      await onSelect(modelName.trim())
      setCustomModel("")
      detailsRef.current?.removeAttribute("open")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="model-picker" ref={detailsRef}>
      <summary aria-label="切换模型">
        <BookOpen size={15} />
        <span>{model.configured ? model.model : "配置模型"}</span>
        <ChevronDown size={13} />
      </summary>
      <div className="model-popover">
        <header><span>本次使用的模型</span><small>{model.provider ?? "OpenAI 兼容接口"}</small></header>
        {model.configured && choices.map((choice) => (
          <button className={choice === model.model ? "active" : ""} key={choice} disabled={disabled || busy} onClick={() => void select(choice)}>
            <span><BookOpen size={13} />{choice}</span>{choice === model.model && <Check size={13} />}
          </button>
        ))}
        {model.configured && (
          <form onSubmit={(event) => { event.preventDefault(); void select(customModel) }}>
            <input value={customModel} onChange={(event) => setCustomModel(event.target.value)} placeholder="输入其他模型 ID" disabled={disabled || busy} />
            <button disabled={!customModel.trim() || disabled || busy}>{busy ? "…" : "切换"}</button>
          </form>
        )}
        {error && <p>{error}</p>}
        <button className="model-settings-link" onClick={() => { detailsRef.current?.removeAttribute("open"); onOpenSettings() }}>
          <Settings size={13} />模型与连接设置
        </button>
      </div>
    </details>
  )
}
