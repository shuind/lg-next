import type { AgentWorkerEvent, AgentWorkerRequest } from "./protocol"
import { runAgent } from "./runner"

const parentPort = process.parentPort

if (!parentPort) throw new Error("Agent worker 必须由 Electron utilityProcess 启动")

const activeRuns = new Map<string, AbortController>()

parentPort.on("message", (messageEvent) => {
  const message = messageEvent.data as AgentWorkerRequest
  if (!message) return
  if (message.type === "cancel") {
    activeRuns.get(message.requestId)?.abort()
    return
  }
  if (activeRuns.has(message.requestId)) return
  const controller = new AbortController()
  activeRuns.set(message.requestId, controller)
  void runAgent(message, (event) => {
    const output: AgentWorkerEvent = { type: "event", requestId: message.requestId, event }
    parentPort.postMessage(output)
  }, controller.signal).finally(() => activeRuns.delete(message.requestId))
})
