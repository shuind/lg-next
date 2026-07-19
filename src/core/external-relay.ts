import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import type { ProjectRuntime } from "./project-runtime"
import { normalizeRelativePath } from "./paths"
import type { RelayApplyResult, RelayInspection, RelayOperation, RelayPackage } from "../shared/contracts"

const relaySourceSchema = z.object({
  path: z.string().min(1),
  revision: z.string().min(1),
  mode: z.enum(["summary", "excerpt", "full"]),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
})

export type RelaySourceSelection = Omit<z.infer<typeof relaySourceSchema>, "revision">

const sessionSchema = z.object({
  version: z.literal(2),
  id: z.string(),
  createdAt: z.iso.datetime(),
  taskId: z.string(),
  instruction: z.string(),
  targetPath: z.string().optional(),
  targetProfile: z.string(),
  projectRevision: z.string(),
  sources: z.array(relaySourceSchema),
  constraints: z.array(z.string()),
  unresolved: z.array(z.string()),
  estimatedTokens: z.number().int().nonnegative(),
})

type RelaySession = z.infer<typeof sessionSchema>

function sessionPath(runtime: ProjectRuntime, id: string): string {
  if (!/^[a-f0-9-]+$/i.test(id)) throw new Error("接力会话 ID 无效")
  return path.join(runtime.root, ".lg", "external", `${id}.json`)
}

async function loadSession(runtime: ProjectRuntime, id: string): Promise<RelaySession> {
  return sessionSchema.parse(JSON.parse(await readFile(sessionPath(runtime, id), "utf8")) as unknown)
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 2.2)
}

function summarizeDeterministically(content: string): { content: string; startLine: number; endLine: number } {
  const lines = content.split(/\r?\n/)
  const headings = lines.map((line, index) => ({ line, index })).filter((item) => /^#{1,6}\s+/.test(item.line)).slice(0, 20)
  const head = lines.slice(0, 45)
  const tail = lines.length > 70 ? lines.slice(-25) : []
  const body = [
    headings.length ? `标题导航：\n${headings.map((item) => `${item.index + 1}: ${item.line}`).join("\n")}` : "",
    "文件开头/结尾导航摘录：",
    head.join("\n"),
    tail.length ? `\n…\n${tail.join("\n")}` : "",
  ].filter(Boolean).join("\n")
  return { content: body, startLine: 1, endLine: lines.length }
}

function renderSource(content: string, selection: RelaySourceSelection): { content: string; startLine?: number; endLine?: number } {
  const lines = content.split(/\r?\n/)
  if (selection.mode === "full") return { content }
  if (selection.mode === "summary") return summarizeDeterministically(content)
  const start = Math.max(1, selection.startLine ?? 1)
  const end = Math.min(lines.length, selection.endLine ?? Math.min(lines.length, start + 199))
  if (end < start) throw new Error(`${selection.path} 的接力行号范围无效`)
  return { content: lines.slice(start - 1, end).join("\n"), startLine: start, endLine: end }
}

function buildPackage(session: RelaySession, renderedSources: Array<{ source: RelaySession["sources"][number]; content: string }>): string {
  const sourceText = renderedSources.map(({ source, content }, index) => [
    `## 来源 ${index + 1}：${source.path}`,
    `revision: ${source.revision}`,
    `mode: ${source.mode}${source.startLine ? `，lines: ${source.startLine}-${source.endLine ?? source.startLine}` : ""}`,
    "",
    content,
  ].join("\n")).join("\n\n---\n\n")
  return `# LG 官网模型接力

你正在临时协助一部由本地 Full Agent 长期管理的小说。只处理这一次请求；不要假设你记得未提供的历史，不要把人物归纳成人物卡，也不要解释作品最终意味着什么。

目标模型：${session.targetProfile}
项目 revision：${session.projectRevision}

## 本次请求

${session.instruction}

${session.targetPath ? `建议写入目标：\`${session.targetPath}\`` : "当前没有指定目标文件；如需新建章节，请给出作品内 Markdown 路径。"}

${session.constraints.length ? `## 约束\n\n${session.constraints.map((item) => `- ${item}`).join("\n")}\n` : ""}
${session.unresolved.length ? `## 仍未决定\n\n${session.unresolved.map((item) => `- ${item}`).join("\n")}\n` : ""}
## 主 Agent 选择的本地材料

${sourceText || "主 Agent 没有选择任何本地来源。信息不足时请明确指出缺少什么，不要自行补造前史。"}

## 返回格式

只把准备交还本地作品的 Markdown 放进以下区块。可以返回多个区块。

<lg-write path="${session.targetPath ?? "章节/第XXX章.md"}" mode="append">
这里仅放新增的 Markdown 正文
</lg-write>

完整替换已有文件时使用 mode="replace"，并提供该文件替换后的完整 Markdown。区块外可以简短说明，但本地系统只会写入区块内内容。不要使用 Markdown 代码围栏包裹 lg-write。`
}

function parseOperations(response: string): Array<Omit<RelayOperation, "canApply" | "issue">> {
  const operations: Array<Omit<RelayOperation, "canApply" | "issue">> = []
  const pattern = /<lg-write\s+path="([^"]+)"\s+mode="(append|replace)"\s*>([\s\S]*?)<\/lg-write>/gi
  for (const match of response.matchAll(pattern)) {
    const relativePath = normalizeRelativePath(match[1].trim())
    if (!relativePath.toLowerCase().endsWith(".md")) throw new Error(`接力结果只能写入 Markdown：${relativePath}`)
    operations.push({ path: relativePath, mode: match[2].toLowerCase() as "append" | "replace", content: match[3].replace(/^\s*\n/, "").replace(/\s*$/, "\n") })
  }
  return operations
}

export async function createRelayPackage(runtime: ProjectRuntime, input: {
  taskId: string
  instruction: string
  activeDocumentPath?: string
  targetPath?: string
  targetProfile?: string
  sources?: RelaySourceSelection[]
  constraints?: string[]
  unresolved?: string[]
  hardTokenLimit?: number
}): Promise<RelayPackage> {
  const instruction = input.instruction.trim()
  if (!instruction) throw new Error("请先说明希望官网模型做什么")
  const files = await runtime.listMarkdown()
  const fallbackPath = input.activeDocumentPath ?? files.filter((file) => /^(章节|正文)\//.test(file)).at(-1)
  const requested = input.sources?.length
    ? input.sources
    : fallbackPath
      ? [{ path: fallbackPath, mode: "full" as const }]
      : []
  const renderedSources: Array<{ source: RelaySession["sources"][number]; content: string }> = []
  for (const requestedSource of requested) {
    const normalized = normalizeRelativePath(requestedSource.path)
    const snapshot = await runtime.readText(normalized)
    const rendered = renderSource(snapshot.content, { ...requestedSource, path: normalized })
    renderedSources.push({
      source: {
        path: normalized,
        revision: snapshot.revision,
        mode: requestedSource.mode,
        startLine: rendered.startLine,
        endLine: rendered.endLine,
      },
      content: rendered.content,
    })
  }
  const projectRevision = (await runtime.versions.list(1))[0]?.commit ?? "uncommitted"
  const now = new Date().toISOString()
  const baseSession: RelaySession = {
    version: 2,
    id: randomUUID(),
    createdAt: now,
    taskId: input.taskId,
    instruction,
    targetPath: input.targetPath ?? input.activeDocumentPath,
    targetProfile: input.targetProfile?.trim() || "官网强模型",
    projectRevision,
    sources: renderedSources.map((item) => item.source),
    constraints: (input.constraints ?? []).map((item) => item.trim()).filter(Boolean),
    unresolved: (input.unresolved ?? []).map((item) => item.trim()).filter(Boolean),
    estimatedTokens: 0,
  }
  let content = buildPackage(baseSession, renderedSources)
  const estimatedTokens = estimateTokens(content)
  const hardLimit = Math.max(1000, input.hardTokenLimit ?? 100_000)
  if (estimatedTokens > hardLimit) {
    throw new Error(`接力包预计 ${estimatedTokens} tokens，超过 ${hardLimit} 上限；请由 Agent 减少来源或降低读取深度，不会自动截断原文`)
  }
  const session = { ...baseSession, estimatedTokens }
  content = buildPackage(session, renderedSources)
  const filePath = sessionPath(runtime, session.id)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(session, null, 2)}\n`, "utf8")
  await writeFile(path.join(runtime.root, ".lg", "external", `${session.id}-package.md`), content, "utf8")
  return {
    id: session.id,
    createdAt: session.createdAt,
    targetPath: session.targetPath,
    sourceCount: session.sources.length,
    estimatedTokens,
    sources: session.sources,
    content,
  }
}

export async function inspectRelayResponse(runtime: ProjectRuntime, sessionId: string, response: string): Promise<RelayInspection> {
  const session = await loadSession(runtime, sessionId)
  const parsed = parseOperations(response)
  const sourceRevisions = Object.fromEntries(session.sources.map((source) => [source.path, source.revision]))
  const operations: RelayOperation[] = []
  for (const operation of parsed) {
    let currentRevision: string | undefined
    try { currentRevision = (await runtime.readText(operation.path)).revision } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const expected = sourceRevisions[operation.path]
    let issue: string | undefined
    if (currentRevision && !expected) issue = "该已有文件不在生成接力包时的可写来源中"
    else if (currentRevision && currentRevision !== expected) issue = "生成接力包后文件已经变化，请重新生成接力包"
    else if (!currentRevision && operation.mode === "replace") issue = "不能用 replace 替换一个不存在的文件；请使用 append 新建"
    else if (!operation.content.trim()) issue = "写入内容为空"
    operations.push({ ...operation, canApply: !issue, issue })
  }
  return { sessionId, operations, canApply: operations.length > 0 && operations.every((operation) => operation.canApply), message: operations.length ? undefined : "没有找到 lg-write 写入区块" }
}

export async function applyRelayResponse(runtime: ProjectRuntime, sessionId: string, response: string): Promise<RelayApplyResult> {
  const session = await loadSession(runtime, sessionId)
  const inspection = await inspectRelayResponse(runtime, sessionId, response)
  if (!inspection.canApply) throw new Error(inspection.message ?? inspection.operations.find((operation) => operation.issue)?.issue ?? "接力结果不能应用")
  const changedPaths: string[] = []
  for (const operation of inspection.operations) {
    let existing: { content: string; revision: string } | undefined
    try { existing = await runtime.readText(operation.path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const content = operation.mode === "replace"
      ? operation.content
      : existing
        ? `${existing.content.replace(/\s*$/, "")}\n\n${operation.content.replace(/^\s*/, "")}`
        : operation.content
    const mutation = await runtime.mutations.apply({
      path: operation.path,
      operation: operation.mode === "replace" ? "replace" : existing ? "edit" : "create",
      beforeRevision: existing?.revision,
      afterContent: content,
      actor: "external-import",
      reason: `官网模型接力：${session.instruction.slice(0, 80)}`,
      sourceTurnId: session.taskId,
    })
    if (mutation.changed) changedPaths.push(operation.path)
  }
  const checkpoint = await runtime.versions.checkpoint(`官网模型接力：${session.instruction.slice(0, 60)}`)
  await writeFile(path.join(runtime.root, ".lg", "external", `${sessionId}-response.md`), response, "utf8")
  return { changedPaths, checkpoint: checkpoint.commit }
}
