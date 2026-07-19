import { randomUUID } from "node:crypto"
import type OpenAI from "openai"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import type { CompactionBoundary } from "./session-store"

export const COMPACTION_PREFIX = "LG_SESSION_COMPACTION_MEMO:"
export const MICROCOMPACTION_PREFIX = "LG_MICROCOMPACTED_TOOL_RESULT:"

const MICROCOMPACT_MIN_CHARACTERS = 2400
const MICROCOMPACT_PREVIEW_CHARACTERS = 900
const RECENT_MESSAGE_COUNT = 18
const RECENT_GROUP_COUNT = 10
const MAX_COMPACTION_INPUT_CHARACTERS = 120_000

export interface CompactionResult {
  messages: ChatCompletionMessageParam[]
  boundary?: CompactionBoundary
  lastCompactedAt?: string
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
}

function stringifyContent(content: ChatCompletionMessageParam["content"]): string {
  if (typeof content === "string") return content
  return content ? JSON.stringify(content) : ""
}

export function estimateMessageTokens(messages: ChatCompletionMessageParam[]): number {
  return Math.ceil(messages.reduce((sum, message) => {
    const toolCalls = message.role === "assistant" && "tool_calls" in message ? JSON.stringify(message.tool_calls ?? []).length : 0
    return sum + stringifyContent(message.content).length + toolCalls + 12
  }, 0) / 2.2)
}

export function contextBudgetForModel(model: string): number {
  const normalized = model.toLowerCase()
  if (normalized.includes("32k")) return 32_000
  if (normalized.includes("64k")) return 64_000
  if (normalized.includes("200k")) return 200_000
  return 128_000
}

function isMemo(message: ChatCompletionMessageParam): boolean {
  return message.role === "system" && stringifyContent(message.content).startsWith(COMPACTION_PREFIX)
}

export function microcompactToolResults(messages: ChatCompletionMessageParam[]): { messages: ChatCompletionMessageParam[]; changed: number } {
  const recentStart = Math.max(0, messages.length - RECENT_MESSAGE_COUNT)
  let changed = 0
  const compacted = messages.map((message, index) => {
    if (index >= recentStart || message.role !== "tool") return message
    const content = stringifyContent(message.content)
    if (content.length < MICROCOMPACT_MIN_CHARACTERS || content.startsWith(MICROCOMPACTION_PREFIX)) return message
    changed += 1
    const preview = content.slice(0, MICROCOMPACT_PREVIEW_CHARACTERS).trim()
    return {
      ...message,
      content: [
        MICROCOMPACTION_PREFIX,
        `original_characters: ${content.length}`,
        "preview:",
        preview,
        content.length > preview.length ? "…" : "",
      ].filter(Boolean).join("\n"),
    } as ChatCompletionMessageParam
  })
  return { messages: compacted, changed }
}

function groupMessages(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[][] {
  const groups: ChatCompletionMessageParam[][] = []
  let current: ChatCompletionMessageParam[] = []
  let pendingToolIds = new Set<string>()

  function flush(): void {
    if (current.length) groups.push(current)
    current = []
    pendingToolIds = new Set()
  }

  for (const message of messages) {
    if (current.length && pendingToolIds.size === 0) flush()
    current.push(message)
    if (message.role === "assistant" && "tool_calls" in message) {
      pendingToolIds = new Set((message.tool_calls ?? []).map((call) => call.id))
    } else if (message.role === "tool") {
      pendingToolIds.delete(message.tool_call_id)
    }
  }
  flush()
  return groups
}

function renderMessage(message: ChatCompletionMessageParam): string {
  const toolCalls = message.role === "assistant" && "tool_calls" in message && message.tool_calls?.length
    ? `\nTOOL_CALLS: ${JSON.stringify(message.tool_calls)}`
    : ""
  return `[${message.role.toUpperCase()}]\n${stringifyContent(message.content)}${toolCalls}`
}

function selectCompactionInput(groups: ChatCompletionMessageParam[][]): { rendered: string; droppedGroups: number } {
  const selected: string[] = []
  let size = 0
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const rendered = groups[index].map(renderMessage).join("\n\n")
    if (selected.length && size + rendered.length > MAX_COMPACTION_INPUT_CHARACTERS) break
    selected.unshift(rendered)
    size += rendered.length
  }
  return { rendered: selected.join("\n\n---\n\n"), droppedGroups: groups.length - selected.length }
}

function structuredPrompt(): string {
  return `为本地小说创作 Agent 合并当前任务的旧会话状态。输出紧凑、具体、可继续执行的中文 memo。

必须保留：
- 用户当前目标、明确纠正的原话和禁止事项；
- 已读取的来源路径、revision、关键原文证据；
- 已完成写入、mutation/ledger 结果和未完成任务；
- 已确认事实、仍未决定的内容、已经废弃的假设；
- 失败工具和需要避免重复的无进展路径。

不得：
- 把人物概括成永久人物卡；
- 推导用户审美画像；
- 把摘要冒充正文事实；
- 补写输入中不存在的情节或结论。

只输出 memo 正文。`
}

export async function compactSession(input: {
  client: OpenAI
  model: string
  messages: ChatCompletionMessageParam[]
  signal?: AbortSignal
  budgetTokens?: number
  triggerTokens?: number
}): Promise<CompactionResult> {
  const budget = input.budgetTokens ?? contextBudgetForModel(input.model)
  const trigger = input.triggerTokens ?? Math.min(96_000, Math.floor(budget * 0.8))
  const before = estimateMessageTokens(input.messages)
  let messages = input.messages

  if (before > budget * 0.6) {
    const micro = microcompactToolResults(messages)
    messages = micro.messages
    if (micro.changed > 0 && estimateMessageTokens(messages) <= trigger) {
      const after = estimateMessageTokens(messages)
      return {
        messages,
        boundary: {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          strategy: "microcompact",
          tokenBefore: before,
          tokenAfter: after,
          changedMessages: micro.changed,
        },
      }
    }
  }

  const tokenBefore = estimateMessageTokens(messages)
  if (tokenBefore <= trigger) return { messages }

  const existingMemos = messages.filter(isMemo)
  const ordinary = messages.filter((message) => !isMemo(message))
  const groups = groupMessages(ordinary)
  if (groups.length <= RECENT_GROUP_COUNT + 2) return { messages }
  const oldGroups = groups.slice(0, -RECENT_GROUP_COUNT)
  const recent = groups.slice(-RECENT_GROUP_COUNT).flat()
  const compactionInput = selectCompactionInput([
    ...existingMemos.map((message) => [message]),
    ...oldGroups,
  ])
  const response = await input.client.chat.completions.create({
    model: input.model,
    messages: [
      { role: "system", content: structuredPrompt() },
      { role: "user", content: compactionInput.rendered },
    ],
    temperature: 0.1,
    max_completion_tokens: 1800,
  }, { signal: input.signal })
  const memoText = response.choices[0]?.message.content?.trim() || "旧会话未能生成有效摘要；后续必须依靠项目文件和原文来源继续。"
  const now = new Date().toISOString()
  messages = [{ role: "system", content: `${COMPACTION_PREFIX}\nupdated_at: ${now}\n\n${memoText}` }, ...recent]
  const tokenAfter = estimateMessageTokens(messages)
  return {
    messages,
    lastCompactedAt: now,
    boundary: {
      id: randomUUID(),
      createdAt: now,
      strategy: "full-summary",
      tokenBefore,
      tokenAfter,
      changedMessages: oldGroups.flat().length,
      droppedGroups: compactionInput.droppedGroups,
    },
    usage: response.usage ? {
      promptTokens: response.usage.prompt_tokens,
      completionTokens: response.usage.completion_tokens,
      totalTokens: response.usage.total_tokens,
    } : undefined,
  }
}
