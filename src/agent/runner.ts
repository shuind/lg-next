import { randomUUID } from "node:crypto"
import OpenAI from "openai"
import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions"
import { ProjectRuntime } from "../core/project-runtime"
import type { TaskEvent } from "../shared/contracts"
import { compactSession, contextBudgetForModel, estimateMessageTokens } from "./compaction"
import type { AgentRunRequest } from "./protocol"
import { AgentSessionStore, type AgentSessionState } from "./session-store"
import { createAgentTools } from "./tools"

type Emit = (event: TaskEvent) => void

interface ToolCallPart {
  id: string
  name: string
  arguments: string
}

interface FunctionToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

interface UsageTotal {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

interface ApiUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  totalTokens: number
}

const SYSTEM_PROMPT = `你是 LG，一个长期住在本地小说作品中的 Full Agent。

正文和用户明确写入的项目文件是作品依据。Story Index、摘要、人物视图和关系视图都只是可疑导航；重要判断应追到带 revision 的原文。不要把人物压成人物卡，不要把关系压成单一结论，不要维护读者状态，也不要解释作品最终意味着什么。

你始终拥有当前作品工作区的完整工具。用户不维护固定工作流。用户说“继续”时，你可以沿写、切换视角、跨越时间、暂离主线或调整软性大纲；自行决定需要搜索多少历史、读片段还是完整章节。不要等待文件写入审批，完成真实动作后再报告。

人物和关系可以推翻尚未发生的软性安排。允许矛盾、未决定内容和暂时没有功能的细节存在。写后检查只防止忘记前文、明显失真、解释过度和模型套话，不负责把正文整理成可概括的答案。

用户明确指出本作品哪里不对并说明原因时，先回读目标 revision，再用 record_correction 原样记录；修订完成后用 resolve_correction 关联实际 ledger。不能从微改、沉默或保留行为推导用户审美。

工具循环按新证据延长：新的原文来源、revision、有效写入或纠正才算进展。无进展时停止重复检索并给出诚实结果。覆盖已有文件前必须读取当前 revision。`

const SOFT_LOOPS = 8
const HARD_LOOPS = 24
const NO_PROGRESS_LIMIT = 3

function eventBase(request: AgentRunRequest) {
  return {
    id: randomUUID(),
    taskId: request.taskId,
    requestId: request.requestId,
    createdAt: new Date().toISOString(),
  }
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function apiUsage(usage: unknown): ApiUsage {
  const value = (usage ?? {}) as Record<string, unknown>
  const promptDetails = (value.prompt_tokens_details ?? {}) as Record<string, unknown>
  const number = (candidate: unknown): number => typeof candidate === "number" && Number.isFinite(candidate) ? Math.max(0, Math.round(candidate)) : 0
  const cachedInputTokens = number(promptDetails.cached_tokens ?? value.prompt_cache_hit_tokens ?? value.cache_read_input_tokens)
  const cacheWriteInputTokens = number(promptDetails.cache_creation_tokens ?? value.cache_creation_input_tokens)
  const promptTokens = number(value.prompt_tokens)
  const inputTokens = promptTokens || number(value.input_tokens) + cachedInputTokens + cacheWriteInputTokens
  const outputTokens = number(value.completion_tokens ?? value.output_tokens)
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    totalTokens: number(value.total_tokens) || inputTokens + outputTokens,
  }
}

function addUsage(total: UsageTotal, rawUsage: unknown): void {
  const usage = apiUsage(rawUsage)
  total.promptTokens += usage.inputTokens
  total.completionTokens += usage.outputTokens
  total.totalTokens += usage.totalTokens
}

function apiCallEvent(request: AgentRunRequest, input: {
  kind: "agent" | "compaction" | "final"
  startedAt: number
  finishedAt?: number
  usage?: unknown
  requestBody?: string
  error?: unknown
}): TaskEvent {
  const usage = apiUsage(input.usage)
  const pricing = request.model.pricing
  const ordinaryInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens)
  const cost = pricing ? (
    ordinaryInput * pricing.inputPerMillion
    + usage.outputTokens * pricing.outputPerMillion
    + usage.cachedInputTokens * pricing.cacheReadPerMillion
    + usage.cacheWriteInputTokens * pricing.cacheWritePerMillion
  ) / 1_000_000 : undefined
  const finishedAt = input.finishedAt ?? Date.now()
  return {
    id: randomUUID(),
    taskId: request.taskId,
    requestId: request.requestId,
    type: "api_call",
    createdAt: new Date(input.startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    status: input.error ? "failed" : "succeeded",
    kind: input.kind,
    recordId: request.model.recordId,
    recordName: request.model.recordName,
    provider: request.model.provider,
    baseUrl: request.model.baseUrl,
    model: request.model.model,
    ...usage,
    latencyMs: Math.max(0, finishedAt - input.startedAt),
    currency: pricing?.currency,
    cost,
    requestBody: input.requestBody,
    error: input.error instanceof Error ? input.error.message : input.error ? String(input.error) : undefined,
  }
}

function taskContext(request: AgentRunRequest): string {
  return [
    "[LG_TASK_CONTEXT]",
    request.activeDocumentPath ? `当前编辑文件：${request.activeDocumentPath}` : "当前没有打开正文文件。",
    request.recentPaths.length ? `最近修改路径：${request.recentPaths.join("、")}` : "当前没有最近修改路径。",
    "这些路径只用于导航，没有自动注入任何正文。请自行使用 search_story 与 read_file 获取证据。",
    "",
    "[USER_REQUEST]",
    request.userMessage,
  ].join("\n")
}

function coldRecoveryMessages(request: AgentRunRequest): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = request.recoveryHistory.map((message) => ({ role: message.role, content: message.content }))
  if (request.recalledHistory.length) {
    messages.push({
      role: "system",
      content: [
        "LG_RECALLED_UI_HISTORY:",
        "以下是任务界面历史中的旧原话，仅用于恢复当前任务连续性，不构成作品事实。",
        ...request.recalledHistory.map((message) => `[${message.role}｜${message.createdAt}] ${message.excerpt}`),
      ].join("\n"),
    })
  }
  return messages
}

function contextWindow(messages: ChatCompletionMessageParam[], model: string, lastCompactedAt?: string) {
  const estimatedTokens = estimateMessageTokens(messages)
  const budgetTokens = contextBudgetForModel(model)
  return { estimatedTokens, budgetTokens, ratio: estimatedTokens / budgetTokens, lastCompactedAt }
}

async function finalWithoutTools(input: {
  client: OpenAI
  model: string
  messages: ChatCompletionMessageParam[]
  emit: Emit
  request: AgentRunRequest
  signal?: AbortSignal
  reason: string
  usage: UsageTotal
}): Promise<string> {
  input.messages.push({ role: "system", content: `${input.reason}\n停止继续调用工具。根据已经验证的证据和实际动作，给用户一个简洁、诚实的最终结果；未完成的部分明确说明。` })
  const requestBody = {
    model: input.model,
    messages: input.messages,
    stream: false as const,
  }
  const serializedRequest = JSON.stringify(requestBody)
  const startedAt = Date.now()
  let response: ChatCompletion
  try {
    response = await input.client.chat.completions.create(requestBody, { signal: input.signal })
    input.emit(apiCallEvent(input.request, { kind: "final", startedAt, usage: response.usage, requestBody: serializedRequest }))
  } catch (error) {
    input.emit(apiCallEvent(input.request, { kind: "final", startedAt, requestBody: serializedRequest, error }))
    throw error
  }
  addUsage(input.usage, response.usage)
  const text = response.choices[0]?.message.content?.trim() || "本次运行已停止，没有生成额外结果。"
  input.emit({ ...eventBase(input.request), type: "assistant_delta", text })
  input.emit({ ...eventBase(input.request), type: "assistant_message", text })
  input.messages.push({ role: "assistant", content: text })
  return text
}

function aborted(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted || (error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message))))
}

export async function runAgent(request: AgentRunRequest, emit: Emit, signal?: AbortSignal): Promise<void> {
  const client = new OpenAI({ apiKey: request.model.apiKey, baseURL: request.model.baseUrl })
  const runtime = new ProjectRuntime(request.projectRoot)
  const sessionStore = new AgentSessionStore(request.projectRoot)
  const loaded = await sessionStore.load(request.taskId)
  const tools = createAgentTools(request.projectRoot, { taskId: request.taskId, sourceTurnId: request.requestId, signal })
  const changedPaths = new Set<string>()
  const seenProgress = new Set<string>()
  const usage: UsageTotal = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  let sessionMessages = loaded?.messages ?? coldRecoveryMessages(request)
  let lastCompactedAt = loaded?.lastCompactedAt
  let boundaries = loaded?.boundaries ?? []
  let messages: ChatCompletionMessageParam[] = [{ role: "system", content: SYSTEM_PROMPT }, ...sessionMessages]

  async function saveSession(): Promise<void> {
    const state: AgentSessionState = {
      version: 1,
      taskId: request.taskId,
      updatedAt: new Date().toISOString(),
      messages: messages.slice(1),
      lastCompactedAt,
      boundaries: boundaries.slice(-40),
    }
    await sessionStore.save(state)
  }

  async function finish(cancelled = false): Promise<void> {
    const checkpoint = changedPaths.size
      ? await runtime.versions.checkpoint(cancelled ? "Agent 中断前的有效修改" : `Agent：${request.userMessage.slice(0, 60) || "完成任务"}`)
      : { created: false }
    await saveSession()
    emit({
      ...eventBase(request),
      type: "done",
      changedPaths: [...changedPaths],
      checkpoint: checkpoint.commit,
      cancelled: cancelled || undefined,
      usage,
      contextWindow: contextWindow(messages.slice(1), request.model.model, lastCompactedAt),
    })
  }

  emit({ ...eventBase(request), type: "status", label: `正在使用 ${request.model.model}` })

  try {
    const compacted = await compactSession({
      client,
      model: request.model.model,
      messages: sessionMessages,
      signal,
      onApiCall: (call) => emit(apiCallEvent(request, { kind: "compaction", ...call })),
    })
    sessionMessages = compacted.messages
    messages = [{ role: "system", content: SYSTEM_PROMPT }, ...sessionMessages]
    if (compacted.usage) {
      usage.promptTokens += compacted.usage.promptTokens
      usage.completionTokens += compacted.usage.completionTokens
      usage.totalTokens += compacted.usage.totalTokens
    }
    if (compacted.boundary) {
      boundaries = [...boundaries, compacted.boundary].slice(-40)
      lastCompactedAt = compacted.lastCompactedAt ?? lastCompactedAt
      emit({
        ...eventBase(request),
        type: "compaction",
        strategy: compacted.boundary.strategy,
        tokenBefore: compacted.boundary.tokenBefore,
        tokenAfter: compacted.boundary.tokenAfter,
        changedMessages: compacted.boundary.changedMessages,
      })
    }

    messages.push({ role: "user", content: taskContext(request) })
    let noProgressLoops = 0

    for (let loop = 0; loop < HARD_LOOPS; loop += 1) {
      if (signal?.aborted) throw new DOMException("Agent run cancelled", "AbortError")
      let text = ""
      const calls = new Map<number, ToolCallPart>()
      const startedAt = Date.now()
      let callUsage: unknown
      const requestBody = {
        model: request.model.model,
        messages,
        tools: tools.map((tool) => tool.definition),
        tool_choice: "auto" as const,
        stream: true as const,
        stream_options: { include_usage: true },
      }
      const serializedRequest = JSON.stringify(requestBody)
      try {
        const stream = await client.chat.completions.create(requestBody, { signal })
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta
          if (delta?.content) {
            text += delta.content
            emit({ ...eventBase(request), type: "assistant_delta", text: delta.content })
          }
          for (const part of delta?.tool_calls ?? []) {
            const current = calls.get(part.index) ?? { id: "", name: "", arguments: "" }
            calls.set(part.index, {
              id: part.id ?? current.id,
              name: part.function?.name ?? current.name,
              arguments: `${current.arguments}${part.function?.arguments ?? ""}`,
            })
          }
          if (chunk.usage) callUsage = chunk.usage
          addUsage(usage, chunk.usage)
        }
        emit(apiCallEvent(request, { kind: "agent", startedAt, usage: callUsage, requestBody: serializedRequest }))
      } catch (error) {
        emit(apiCallEvent(request, { kind: "agent", startedAt, usage: callUsage, requestBody: serializedRequest, error }))
        throw error
      }

      const toolCalls: FunctionToolCall[] = [...calls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => ({
          id: call.id || randomUUID(),
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        }))
      const assistantMessage: ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      }
      messages.push(assistantMessage)

      if (toolCalls.length === 0) {
        if (text) emit({ ...eventBase(request), type: "assistant_message", text })
        await finish()
        return
      }

      let loopProgress = false
      for (const call of toolCalls) {
        if (signal?.aborted) throw new DOMException("Agent run cancelled", "AbortError")
        const tool = tools.find((candidate) => candidate.definition.type === "function" && candidate.definition.function.name === call.function.name)
        const input = parseArguments(call.function.arguments)
        const label = tool?.label(input) ?? call.function.name
        const toolEventId = randomUUID()
        emit({ ...eventBase(request), id: toolEventId, type: "tool", name: call.function.name, label, status: "running" })
        let result = { ok: false, content: `未知工具：${call.function.name}` } as Awaited<ReturnType<(typeof tools)[number]["execute"]>>
        try {
          if (tool) result = await tool.execute(input, { signal, taskId: request.taskId, sourceTurnId: request.requestId })
        } catch (error) {
          if (aborted(error, signal)) throw error
          result = { ok: false, content: error instanceof Error ? error.message : String(error) }
        }
        if (result.changedPath) changedPaths.add(result.changedPath)
        for (const source of result.sources ?? []) {
          emit({ ...eventBase(request), type: "source", ...source })
        }
        if (result.handoff) emit({ ...eventBase(request), type: "handoff", package: result.handoff })
        for (const key of result.progressKeys ?? []) {
          if (seenProgress.has(key)) continue
          seenProgress.add(key)
          loopProgress = true
        }
        emit({
          ...eventBase(request),
          id: toolEventId,
          type: "tool",
          name: call.function.name,
          label,
          status: result.ok ? "completed" : "failed",
          detail: result.content.slice(0, 4000),
        })
        messages.push({ role: "tool", tool_call_id: call.id, content: result.content })
      }

      noProgressLoops = loopProgress ? 0 : noProgressLoops + 1
      const currentTokens = estimateMessageTokens(messages)
      const budget = contextBudgetForModel(request.model.model)
      if (currentTokens >= budget * 0.94) {
        await finalWithoutTools({ client, model: request.model.model, messages, emit, request, signal, usage, reason: "上下文已接近硬上限。", })
        await finish()
        return
      }
      if (noProgressLoops >= NO_PROGRESS_LIMIT) {
        await finalWithoutTools({ client, model: request.model.model, messages, emit, request, signal, usage, reason: "连续多轮没有获得新的来源、revision、写入或纠正。", })
        await finish()
        return
      }
      if (loop + 1 >= SOFT_LOOPS && !loopProgress) {
        messages.push({ role: "system", content: "已超过默认软循环预算，且本轮没有新证据。只有存在一个明确、必要的新来源或写入时才继续调用工具，否则现在结束。" })
      }
    }

    await finalWithoutTools({ client, model: request.model.model, messages, emit, request, signal, usage, reason: "已达到本次任务的硬循环上限。", })
    await finish()
  } catch (error) {
    if (aborted(error, signal)) {
      emit({ ...eventBase(request), type: "cancelled", message: "已停止本次 Agent 任务。" })
      await finish(true)
      return
    }
    if (messages.length > 1) await saveSession().catch(() => undefined)
    emit({ ...eventBase(request), type: "error", message: error instanceof Error ? error.message : String(error) })
    await finish()
  }
}
