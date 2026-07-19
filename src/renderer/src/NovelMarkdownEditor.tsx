import { useState } from "react"
import { defaultValueCtx, Editor, rootCtx } from "@milkdown/core"
import { commonmark } from "@milkdown/preset-commonmark"
import { listener, listenerCtx } from "@milkdown/plugin-listener"
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react"

function MilkdownEditor({ documentKey, initialValue, onChange }: { documentKey: string; initialValue: string; onChange(value: string): void }): React.JSX.Element {
  useEditor((root) => Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root)
      ctx.set(defaultValueCtx, initialValue)
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown, previous) => {
        if (markdown !== previous) onChange(markdown)
      })
    })
    .use(commonmark)
    .use(listener), [documentKey])
  return <Milkdown />
}

export function NovelMarkdownEditor({
  documentKey,
  value,
  onChange,
}: {
  documentKey: string
  value: string
  onChange(value: string): void
}): React.JSX.Element {
  const [sourceMode, setSourceMode] = useState(false)
  return (
    <div className="novel-editor">
      <div className="editor-mode-toggle">
        <button className={!sourceMode ? "active" : ""} onClick={() => setSourceMode(false)}>正文</button>
        <button className={sourceMode ? "active" : ""} onClick={() => setSourceMode(true)}>Markdown</button>
      </div>
      {sourceMode ? (
        <textarea className="source-editor" value={value} onChange={(event) => onChange(event.target.value)} spellCheck={false} />
      ) : (
        <MilkdownProvider key={`${documentKey}:visual`}>
          <MilkdownEditor documentKey={documentKey} initialValue={value} onChange={onChange} />
        </MilkdownProvider>
      )}
    </div>
  )
}
