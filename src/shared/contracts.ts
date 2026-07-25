import { z } from "zod"

export interface OpenedProject {
  id: string
  name: string
  path: string
  tasks: TaskSummary[]
  files: string[]
  sourceKind: "lg-next" | "portable-book" | "markdown-folder" | "empty"
  lifecycle: "shell" | "active" | "external"
}

export interface RecentProject {
  path: string
  name: string
  lastOpenedAt: string
}

export interface TaskSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

export interface TextDocument {
  path: string
  content: string
  revision: string
}

export interface TextWriteResult extends TextDocument {
  checkpoint: {
    created: boolean
    commit?: string
  }
}

export type TaskEvent =
  | {
      id: string
      taskId: string
      requestId: string
      type: "user_message"
      createdAt: string
      text: string
    }
  | {
      id: string
      taskId: string
      requestId: string
      type: "status"
      createdAt: string
      label: string
    }
  | {
      id: string
      taskId: string
      requestId: string
      type: "assistant_delta"
      createdAt: string
      text: string
    }
  | {
      id: string
      taskId: string
      requestId: string
      type: "assistant_message"
      createdAt: string
      text: string
    }
  | {
      id: string
      taskId: string
      requestId: string
      type: "tool"
      createdAt: string
      name: string
      label: string
      status: "running" | "completed" | "failed"
      detail?: string
    }
  | {
      id: string
      taskId: string
      requestId: string
      type: "source"
      createdAt: string
      path: string
      revision: string
      startLine?: number
      endLine?: number
      excerpt?: string
    }
  | {
      id: string
      taskId: string
      requestId: string
      type: "compaction"
      createdAt: string
      strategy: "microcompact" | "full-summary"
      tokenBefore: number
      tokenAfter: number
      changedMessages: number
    }
  | {
      id: string
      taskId: string
      requestId: string
      type: "api_call"
      createdAt: string
      finishedAt: string
      status: "succeeded" | "failed"
      kind: "agent" | "compaction" | "final"
      recordId?: string
      recordName?: string
      provider: string
      baseUrl: string
      model: string
      inputTokens: number
      outputTokens: number
      cachedInputTokens: number
      cacheWriteInputTokens: number
      totalTokens: number
      latencyMs: number
      currency?: ModelPriceCurrency
      cost?: number
      requestBody?: string
      error?: string
    }
  | {
      id: string
      taskId: string
      requestId: string
      type: "cancelled"
      createdAt: string
      message: string
    }
  | {
      id: string
      taskId: string
      requestId: string
      type: "handoff"
      createdAt: string
      package: RelayPackage
    }
  | {
      id: string
      taskId: string
      requestId: string
      type: "error"
      createdAt: string
      message: string
    }
  | {
      id: string
      taskId: string
      requestId: string
      type: "done"
      createdAt: string
      changedPaths: string[]
      checkpoint?: string
      usage?: {
        promptTokens: number
        completionTokens: number
        totalTokens: number
      }
      cancelled?: boolean
      contextWindow?: {
        estimatedTokens: number
        budgetTokens: number
        ratio: number
        lastCompactedAt?: string
      }
    }

export interface ModelStatus {
  configured: boolean
  recordId?: string
  recordName?: string
  provider?: string
  model?: string
  baseUrl?: string
  source?: "app" | "environment" | "none"
}

export type ModelPriceCurrency = "CNY" | "USD"

export interface ModelPricing {
  currency: ModelPriceCurrency
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion: number
  cacheWritePerMillion: number
}

export interface ModelSettingsInput {
  id?: string
  name: string
  provider: string
  baseUrl: string
  model: string
  apiKey?: string
  pricing: ModelPricing
}

export interface ModelRecordView {
  id: string
  name: string
  provider: string
  baseUrl: string
  model: string
  recentModels: string[]
  hasApiKey: boolean
  source: "app" | "environment" | "none"
  pricing: ModelPricing
  updatedAt?: string
}

export interface ModelSettingsView {
  activeRecordId?: string
  records: ModelRecordView[]
  provider: string
  baseUrl: string
  model: string
  recentModels: string[]
  hasApiKey: boolean
  source: "app" | "environment" | "none"
}

export interface DailyUsage {
  date: string
  runs: number
  tokens: number
}

export interface ProjectUsageStats {
  projectName?: string
  taskCount: number
  messageCount: number
  runCount: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  characterCount: number
  changedFileCount: number
  activeDayCount: number
  lastActiveAt?: string
  daily: DailyUsage[]
}

export interface ModelTestResult {
  ok: boolean
  latencyMs: number
  reply: string
}

export type ApiCallRecord = Extract<TaskEvent, { type: "api_call" }>

export interface StoryIndexStatus {
  state: "ready" | "stale" | "missing"
  builtAt?: string
  documentCount: number
  chunkCount: number
}

export interface StoryIndexHit {
  id: string
  path: string
  heading?: string
  startLine: number
  endLine: number
  score: number
  excerpt: string
}

export interface RelayPackage {
  id: string
  createdAt: string
  targetPath?: string
  sourceCount: number
  estimatedTokens: number
  sources: Array<{
    path: string
    revision: string
    mode: "summary" | "excerpt" | "full"
    startLine?: number
    endLine?: number
  }>
  content: string
}

export interface RelayOperation {
  path: string
  mode: "append" | "replace"
  content: string
  canApply: boolean
  issue?: string
}

export interface RelayInspection {
  sessionId: string
  operations: RelayOperation[]
  canApply: boolean
  message?: string
}

export interface RelayApplyResult {
  changedPaths: string[]
  checkpoint?: string
}

export interface VersionCheckpoint {
  commit: string
  createdAt: string
  label: string
  files: Array<{ status: string; path: string }>
}

export interface VersionDiff {
  commit: string
  patch: string
}

export type AgentEvent =
  | {
      id: string
      type: "commentary"
      createdAt: string
      text: string
    }
  | {
      id: string
      type: "tool"
      createdAt: string
      label: string
      detail?: string
      status: "running" | "completed" | "failed"
    }
  | {
      id: string
      type: "result"
      createdAt: string
      text: string
      changedPaths: string[]
    }

export interface DesktopApi {
  versions(): {
    electron: string
    chrome: string
    node: string
    platform: NodeJS.Platform
  }
  openProject(): Promise<OpenedProject | null>
  createProject(title: string): Promise<OpenedProject | null>
  restoreProject(): Promise<OpenedProject | null>
  openRecentProject(projectPath: string): Promise<OpenedProject>
  listRecentProjects(): Promise<RecentProject[]>
  createTask(projectPath: string, title: string): Promise<TaskSummary>
  listMarkdown(projectPath: string): Promise<string[]>
  readText(projectPath: string, relativePath: string): Promise<TextDocument>
  writeText(input: {
    projectPath: string
    relativePath: string
    content: string
    expectedRevision?: string
    checkpointLabel: string
  }): Promise<TextWriteResult>
  listTaskEvents(projectPath: string, taskId: string): Promise<TaskEvent[]>
  runAgent(input: { projectPath: string; taskId: string; message: string; activeDocumentPath?: string }): Promise<{ requestId: string }>
  cancelAgent(requestId: string): Promise<{ cancelled: boolean }>
  onAgentEvent(listener: (event: TaskEvent) => void): () => void
  modelStatus(): Promise<ModelStatus>
  modelSettings(): Promise<ModelSettingsView>
  saveModelSettings(input: ModelSettingsInput): Promise<ModelSettingsView>
  activateModelRecord(recordId: string): Promise<ModelSettingsView>
  deleteModelRecord(recordId: string): Promise<ModelSettingsView>
  testModel(input?: ModelSettingsInput): Promise<ModelTestResult>
  apiCallRecords(projectPath?: string, limit?: number): Promise<ApiCallRecord[]>
  projectUsage(projectPath?: string): Promise<ProjectUsageStats>
  storyIndexStatus(projectPath: string): Promise<StoryIndexStatus>
  refreshStoryIndex(projectPath: string): Promise<StoryIndexStatus>
  searchStoryIndex(projectPath: string, query: string, limit?: number): Promise<StoryIndexHit[]>
  createRelayPackage(input: { projectPath: string; taskId: string; instruction: string; activeDocumentPath?: string }): Promise<RelayPackage>
  inspectRelayResponse(input: { projectPath: string; sessionId: string; response: string }): Promise<RelayInspection>
  applyRelayResponse(input: { projectPath: string; sessionId: string; response: string }): Promise<RelayApplyResult>
  copyText(text: string): Promise<void>
  listVersions(projectPath: string, limit?: number): Promise<VersionCheckpoint[]>
  versionDiff(projectPath: string, commit: string): Promise<VersionDiff>
  restoreVersion(projectPath: string, commit: string, label: string): Promise<{ created: boolean; commit?: string }>
}

export const agentEventSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(1),
    type: z.literal("commentary"),
    createdAt: z.iso.datetime(),
    text: z.string(),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("tool"),
    createdAt: z.iso.datetime(),
    label: z.string(),
    detail: z.string().optional(),
    status: z.enum(["running", "completed", "failed"]),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("result"),
    createdAt: z.iso.datetime(),
    text: z.string(),
    changedPaths: z.array(z.string()),
  }),
])

const taskEventBase = {
  id: z.string().min(1),
  taskId: z.string().min(1),
  requestId: z.string().min(1),
  createdAt: z.iso.datetime(),
}

export const taskEventSchema = z.discriminatedUnion("type", [
  z.object({ ...taskEventBase, type: z.literal("user_message"), text: z.string() }),
  z.object({ ...taskEventBase, type: z.literal("status"), label: z.string() }),
  z.object({ ...taskEventBase, type: z.literal("assistant_delta"), text: z.string() }),
  z.object({ ...taskEventBase, type: z.literal("assistant_message"), text: z.string() }),
  z.object({
    ...taskEventBase,
    type: z.literal("tool"),
    name: z.string(),
    label: z.string(),
    status: z.enum(["running", "completed", "failed"]),
    detail: z.string().optional(),
  }),
  z.object({
    ...taskEventBase,
    type: z.literal("source"),
    path: z.string(),
    revision: z.string(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    excerpt: z.string().optional(),
  }),
  z.object({
    ...taskEventBase,
    type: z.literal("compaction"),
    strategy: z.enum(["microcompact", "full-summary"]),
    tokenBefore: z.number().int().nonnegative(),
    tokenAfter: z.number().int().nonnegative(),
    changedMessages: z.number().int().nonnegative(),
  }),
  z.object({
    ...taskEventBase,
    type: z.literal("api_call"),
    finishedAt: z.iso.datetime(),
    status: z.enum(["succeeded", "failed"]),
    kind: z.enum(["agent", "compaction", "final"]),
    recordId: z.string().optional(),
    recordName: z.string().optional(),
    provider: z.string(),
    baseUrl: z.string(),
    model: z.string(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    cacheWriteInputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    latencyMs: z.number().int().nonnegative(),
    currency: z.enum(["CNY", "USD"]).optional(),
    cost: z.number().nonnegative().optional(),
    requestBody: z.string().optional(),
    error: z.string().optional(),
  }),
  z.object({ ...taskEventBase, type: z.literal("cancelled"), message: z.string() }),
  z.object({
    ...taskEventBase,
    type: z.literal("handoff"),
    package: z.object({
      id: z.string(),
      createdAt: z.string(),
      targetPath: z.string().optional(),
      sourceCount: z.number().int().nonnegative(),
      estimatedTokens: z.number().int().nonnegative(),
      sources: z.array(z.object({
        path: z.string(),
        revision: z.string(),
        mode: z.enum(["summary", "excerpt", "full"]),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
      })),
      content: z.string(),
    }),
  }),
  z.object({ ...taskEventBase, type: z.literal("error"), message: z.string() }),
  z.object({
    ...taskEventBase,
    type: z.literal("done"),
    changedPaths: z.array(z.string()),
    checkpoint: z.string().optional(),
    usage: z.object({
      promptTokens: z.number().nonnegative(),
      completionTokens: z.number().nonnegative(),
      totalTokens: z.number().nonnegative(),
    }).optional(),
    cancelled: z.boolean().optional(),
    contextWindow: z.object({
      estimatedTokens: z.number().nonnegative(),
      budgetTokens: z.number().positive(),
      ratio: z.number().nonnegative(),
      lastCompactedAt: z.string().optional(),
    }).optional(),
  }),
])
