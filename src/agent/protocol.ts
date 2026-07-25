import type { ModelPricing, TaskEvent } from "../shared/contracts"

export interface ModelConfig {
  recordId?: string
  recordName?: string
  provider: string
  apiKey: string
  baseUrl: string
  model: string
  pricing?: ModelPricing
}

export interface AgentHistoryMessage {
  role: "user" | "assistant"
  content: string
}

export interface RecalledHistoryMessage extends AgentHistoryMessage {
  createdAt: string
  excerpt: string
}

export interface AgentRunRequest {
  type: "run"
  requestId: string
  projectRoot: string
  taskId: string
  userMessage: string
  recoveryHistory: AgentHistoryMessage[]
  model: ModelConfig
  activeDocumentPath?: string
  recentPaths: string[]
  recalledHistory: RecalledHistoryMessage[]
}

export interface AgentCancelRequest {
  type: "cancel"
  requestId: string
}

export type AgentWorkerRequest = AgentRunRequest | AgentCancelRequest

export interface AgentWorkerEvent {
  type: "event"
  requestId: string
  event: TaskEvent
}
