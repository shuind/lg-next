import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ChatCompletionTool } from "openai/resources/chat/completions"
import { ProjectRuntime } from "../core/project-runtime"
import type { StoryKind } from "../core/story-index"
import { createRelayPackage, type RelaySourceSelection } from "../core/external-relay"
import type { RelayPackage } from "../shared/contracts"

const execFileAsync = promisify(execFile)

export interface AgentToolSource {
  path: string
  revision: string
  startLine?: number
  endLine?: number
  excerpt?: string
}

export interface AgentToolResult {
  ok: boolean
  content: string
  changedPath?: string
  ledgerId?: string
  sources?: AgentToolSource[]
  progressKeys?: string[]
  handoff?: RelayPackage
}

export interface AgentToolContext {
  signal?: AbortSignal
  taskId?: string
  sourceTurnId?: string
}

export interface AgentTool {
  definition: ChatCompletionTool
  label(input: Record<string, unknown>): string
  execute(input: Record<string, unknown>, context?: AgentToolContext): Promise<AgentToolResult>
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function positiveInteger(value: unknown, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(maximum, Math.floor(value))
    : fallback
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined
}

function compact(value: string, limit = 12_000): string {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n…（结果已截断）`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function createAgentTools(projectRoot: string, defaultContext: AgentToolContext = {}): AgentTool[] {
  const runtime = new ProjectRuntime(projectRoot)

  return [
    {
      definition: {
        type: "function",
        function: {
          name: "prepare_external_handoff",
          description: "为一次官网强模型任务选择本地来源并生成确定性接力包。你必须自行决定每个来源读摘要导航、局部原文还是全文；系统不会固定组包或自动截断超预算原文。",
          parameters: {
            type: "object",
            properties: {
              instruction: { type: "string" },
              target_path: { type: "string" },
              target_profile: { type: "string" },
              sources: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    mode: { type: "string", enum: ["summary", "excerpt", "full"] },
                    start_line: { type: "number" },
                    end_line: { type: "number" },
                  },
                  required: ["path", "mode"],
                  additionalProperties: false,
                },
              },
              constraints: { type: "array", items: { type: "string" } },
              unresolved: { type: "array", items: { type: "string" } },
              hard_token_limit: { type: "number" },
            },
            required: ["instruction", "sources"],
            additionalProperties: false,
          },
        },
      },
      label: () => "为官网强模型准备一次性接力材料",
      async execute(input, context) {
        const taskId = context?.taskId ?? defaultContext.taskId
        if (!taskId) return { ok: false, content: "当前运行缺少 taskId，无法创建接力包" }
        const sources: RelaySourceSelection[] = Array.isArray(input.sources) ? input.sources.flatMap((value) => {
          const item = asRecord(value)
          if (!item) return []
          const sourcePath = stringValue(item.path)
          const mode = item.mode === "summary" || item.mode === "excerpt" || item.mode === "full" ? item.mode : null
          if (!sourcePath || !mode) return []
          return [{ path: sourcePath, mode, startLine: optionalInteger(item.start_line), endLine: optionalInteger(item.end_line) }]
        }) : []
        const relay = await createRelayPackage(runtime, {
          taskId,
          instruction: stringValue(input.instruction),
          targetPath: stringValue(input.target_path) || undefined,
          targetProfile: stringValue(input.target_profile) || undefined,
          sources,
          constraints: stringArray(input.constraints),
          unresolved: stringArray(input.unresolved),
          hardTokenLimit: positiveInteger(input.hard_token_limit, 100_000, 500_000),
        })
        return {
          ok: true,
          content: JSON.stringify({ id: relay.id, targetPath: relay.targetPath, sourceCount: relay.sourceCount, estimatedTokens: relay.estimatedTokens, sources: relay.sources }, null, 2),
          handoff: relay,
          sources: relay.sources.map((source) => ({ path: source.path, revision: source.revision, startLine: source.startLine, endLine: source.endLine })),
          progressKeys: [`handoff:${relay.id}`, ...relay.sources.map((source) => `source:${source.path}:${source.revision}:${source.mode}`)],
        }
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "search_story",
          description: "在可重建 Story Index 中寻找可能相关的原文来源和项目纠正。结果只是导航；重要内容必须继续 read_file 回读原文。可以按实体、路径、材料种类和章节顺序缩小范围。",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "自然语言、旧话、物件或事件查询" },
              entities: { type: "array", items: { type: "string" }, description: "需要共同查找的人物、地点或物件" },
              path_glob: { type: "string", description: "可选作品内路径 glob" },
              kinds: { type: "array", items: { type: "string", enum: ["chapter", "outline", "setting", "material", "constraint", "other"] } },
              before_sequence: { type: "number" },
              after_sequence: { type: "number" },
              detail: { type: "string", enum: ["paths", "snippets"] },
              limit: { type: "number" },
              cursor: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      },
      label: (input) => `检索作品历史：“${stringValue(input.query) || stringArray(input.entities).join("、") || "按范围查找"}”`,
      async execute(input) {
        const query = stringValue(input.query).trim()
        const entities = stringArray(input.entities).map((item) => item.trim()).filter(Boolean)
        const kinds = stringArray(input.kinds).filter((item): item is StoryKind => ["chapter", "outline", "setting", "material", "constraint", "other"].includes(item))
        const page = await runtime.storyIndex.searchPage({
          query,
          entities,
          pathGlob: stringValue(input.path_glob) || undefined,
          kinds: kinds.length ? kinds : undefined,
          beforeSequence: optionalInteger(input.before_sequence),
          afterSequence: optionalInteger(input.after_sequence),
          detail: input.detail === "paths" ? "paths" : "snippets",
          limit: positiveInteger(input.limit, 12, 50),
          cursor: stringValue(input.cursor) || undefined,
        })
        const correctionQuery = [query, ...entities].filter(Boolean).join(" ")
        const corrections = correctionQuery ? await runtime.corrections.search(correctionQuery, 6) : []
        return {
          ok: true,
          content: JSON.stringify({ ...page, corrections }, null, 2),
          sources: page.hits.map((hit) => ({
            path: hit.path,
            revision: hit.revision,
            startLine: hit.startLine,
            endLine: hit.endLine,
            excerpt: hit.excerpt,
          })),
          progressKeys: [
            ...page.hits.map((hit) => `source:${hit.path}:${hit.revision}:${hit.startLine}`),
            ...corrections.map((correction) => `correction:${correction.id}:${correction.updatedAt}`),
          ],
        }
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "list_files",
          description: "列出当前作品中的 Markdown 文件。",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      },
      label: () => "查看作品文件",
      async execute() {
        const files = await runtime.listMarkdown()
        return { ok: true, content: JSON.stringify({ files }, null, 2), progressKeys: files.map((file) => `path:${file}`) }
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "read_file",
          description: "读取当前作品内的 UTF-8 文本文件，返回带行号范围的原文和 revision。需要判断人物、关系或事实时，以此工具读到的原文为依据。",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "作品内相对路径" },
              offset: { type: "number", description: "可选，1 起始行" },
              limit: { type: "number", description: "可选，最多读取行数" },
            },
            required: ["path"],
            additionalProperties: false,
          },
        },
      },
      label: (input) => `读取 ${stringValue(input.path)}`,
      async execute(input) {
        const snapshot = await runtime.readText(stringValue(input.path))
        const lines = snapshot.content.split(/\r?\n/)
        const offset = positiveInteger(input.offset, 1, Math.max(1, lines.length))
        const limit = positiveInteger(input.limit, lines.length, 4000)
        const endLine = Math.min(lines.length, offset - 1 + limit)
        const content = lines.slice(offset - 1, endLine).join("\n")
        return {
          ok: true,
          content: JSON.stringify({
            path: snapshot.path,
            revision: snapshot.revision,
            totalLines: lines.length,
            startLine: offset,
            endLine,
            content,
          }, null, 2),
          sources: [{ path: snapshot.path, revision: snapshot.revision, startLine: offset, endLine, excerpt: content.slice(0, 500) }],
          progressKeys: [`source:${snapshot.path}:${snapshot.revision}:${offset}-${endLine}`],
        }
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "write_file",
          description: "通过统一 Mutation Service 直接写入作品文件。覆盖已有文件时必须提供读取时得到的 expected_revision。",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
              expected_revision: { type: "string" },
              reason: { type: "string", description: "本次修改的简短原因" },
            },
            required: ["path", "content"],
            additionalProperties: false,
          },
        },
      },
      label: (input) => `写入 ${stringValue(input.path)}`,
      async execute(input, context) {
        const filePath = stringValue(input.path)
        const expectedRevision = stringValue(input.expected_revision) || undefined
        try {
          const existing = await runtime.readText(filePath)
          if (!expectedRevision) return { ok: false, content: `覆盖 ${filePath} 前必须先读取并提供 expected_revision` }
          if (existing.revision !== expectedRevision) return { ok: false, content: `${filePath} 已变化，请重新读取` }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
        const result = await runtime.mutations.apply({
          path: filePath,
          operation: "replace",
          beforeRevision: expectedRevision,
          afterContent: stringValue(input.content),
          actor: "agent",
          reason: stringValue(input.reason) || "Agent 写入",
          sourceTurnId: context?.sourceTurnId ?? defaultContext.sourceTurnId,
        })
        return {
          ok: true,
          content: JSON.stringify({ path: result.path, revision: result.afterRevision, changed: result.changed, ledgerId: result.ledger?.id }),
          changedPath: result.changed ? result.path : undefined,
          ledgerId: result.ledger?.id,
          progressKeys: result.changed ? [`mutation:${result.path}:${result.afterRevision}`] : [],
        }
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "edit_file",
          description: "通过统一 Mutation Service 用精确文本替换编辑作品文件；匹配不唯一时拒绝修改。",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              old_text: { type: "string" },
              new_text: { type: "string" },
              reason: { type: "string" },
            },
            required: ["path", "old_text", "new_text"],
            additionalProperties: false,
          },
        },
      },
      label: (input) => `编辑 ${stringValue(input.path)}`,
      async execute(input, context) {
        const filePath = stringValue(input.path)
        const oldText = stringValue(input.old_text)
        if (!oldText) return { ok: false, content: "old_text 不能为空" }
        const snapshot = await runtime.readText(filePath)
        const occurrences = snapshot.content.split(oldText).length - 1
        if (occurrences !== 1) return { ok: false, content: `需要唯一匹配，实际找到 ${occurrences} 处` }
        const result = await runtime.mutations.apply({
          path: filePath,
          operation: "edit",
          beforeRevision: snapshot.revision,
          afterContent: snapshot.content.replace(oldText, stringValue(input.new_text)),
          actor: "agent",
          reason: stringValue(input.reason) || "Agent 精确编辑",
          sourceTurnId: context?.sourceTurnId ?? defaultContext.sourceTurnId,
        })
        return {
          ok: true,
          content: JSON.stringify({ path: result.path, revision: result.afterRevision, changed: result.changed, ledgerId: result.ledger?.id }),
          changedPath: result.changed ? result.path : undefined,
          ledgerId: result.ledger?.id,
          progressKeys: result.changed ? [`mutation:${result.path}:${result.afterRevision}`] : [],
        }
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "record_correction",
          description: "仅当用户明确指出当前作品哪里不对以及原因时，原样记录这条项目纠正。不要从微改、沉默或保留行为推断审美，也不要把纠正推广成跨作品规则。",
          parameters: {
            type: "object",
            properties: {
              user_text: { type: "string", description: "用户纠正的原话，不要改写" },
              targets: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    revision: { type: "string" },
                    start_line: { type: "number" },
                    end_line: { type: "number" },
                  },
                  required: ["path", "revision"],
                  additionalProperties: false,
                },
              },
              characters: { type: "array", items: { type: "string" } },
              relationships: { type: "array", items: { type: "array", items: { type: "string" } } },
              chapters: { type: "array", items: { type: "string" } },
            },
            required: ["user_text", "targets"],
            additionalProperties: false,
          },
        },
      },
      label: () => "记录用户对本作品的明确纠正",
      async execute(input, context) {
        const sourceTurnId = context?.sourceTurnId ?? defaultContext.sourceTurnId
        if (!sourceTurnId) return { ok: false, content: "当前运行缺少 sourceTurnId，无法可靠记录纠正" }
        const targets = Array.isArray(input.targets) ? input.targets.flatMap((value) => {
          const item = asRecord(value)
          if (!item) return []
          const target = {
            path: stringValue(item.path),
            revision: stringValue(item.revision),
            startLine: optionalInteger(item.start_line),
            endLine: optionalInteger(item.end_line),
          }
          return target.path && target.revision ? [target] : []
        }) : []
        if (!stringValue(input.user_text).trim() || !targets.length) return { ok: false, content: "纠正必须包含用户原话和至少一个带 revision 的正文目标" }
        for (const target of targets) {
          const current = await runtime.readText(target.path)
          if (current.revision !== target.revision) return { ok: false, content: `${target.path} 已变化，请重新读取后再记录纠正` }
        }
        const relationships = Array.isArray(input.relationships)
          ? input.relationships.map((value) => stringArray(value).filter(Boolean)).filter((value) => value.length > 1)
          : []
        const correction = await runtime.corrections.record({
          userText: stringValue(input.user_text),
          sourceTurnId,
          targets,
          scopeHints: {
            characters: stringArray(input.characters),
            relationships,
            chapters: stringArray(input.chapters),
          },
        })
        return {
          ok: true,
          content: JSON.stringify(correction, null, 2),
          progressKeys: [`correction:${correction.id}:${correction.updatedAt}`],
        }
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "resolve_correction",
          description: "在完成对应修订后，把项目纠正关联到实际 mutation ledger 记录。",
          parameters: {
            type: "object",
            properties: {
              correction_id: { type: "string" },
              ledger_ids: { type: "array", items: { type: "string" } },
              note: { type: "string" },
              status: { type: "string", enum: ["resolved", "superseded"] },
            },
            required: ["correction_id", "ledger_ids"],
            additionalProperties: false,
          },
        },
      },
      label: () => "关联纠正与实际修订",
      async execute(input) {
        const ledgerIds = stringArray(input.ledger_ids)
        const knownLedgerIds = new Set((await runtime.mutations.ledger.list(1000)).map((entry) => entry.id))
        const missing = ledgerIds.filter((id) => !knownLedgerIds.has(id))
        if (missing.length) return { ok: false, content: `找不到 mutation ledger：${missing.join("、")}` }
        const correction = await runtime.corrections.resolve(stringValue(input.correction_id), {
          ledgerIds,
          note: stringValue(input.note) || undefined,
          status: input.status === "superseded" ? "superseded" : "resolved",
        })
        return { ok: true, content: JSON.stringify(correction, null, 2), progressKeys: [`correction:${correction.id}:${correction.updatedAt}`] }
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "run_command",
          description: "在作品目录中执行 PowerShell 命令。用于通用本地任务；正文写入仍优先使用统一文件工具。",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string" },
              timeout_ms: { type: "number" },
            },
            required: ["command"],
            additionalProperties: false,
          },
        },
      },
      label: () => "执行本地命令",
      async execute(input, context) {
        const command = stringValue(input.command)
        if (!command) return { ok: false, content: "命令不能为空" }
        const timeout = positiveInteger(input.timeout_ms, 30_000, 120_000)
        try {
          const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
            cwd: projectRoot,
            windowsHide: true,
            timeout,
            maxBuffer: 10 * 1024 * 1024,
            signal: context?.signal ?? defaultContext.signal,
          })
          return { ok: true, content: compact(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim()) }
        } catch (error) {
          const failure = error as Error & { stdout?: string; stderr?: string }
          return { ok: false, content: compact([failure.message, failure.stdout, failure.stderr].filter(Boolean).join("\n")) }
        }
      },
    },
  ]
}
