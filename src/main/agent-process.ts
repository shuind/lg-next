import { utilityProcess, type UtilityProcess } from "electron"
import agentWorkerPath from "../agent/worker?modulePath"
import type { AgentRunRequest, AgentWorkerEvent } from "../agent/protocol"

export class AgentProcess {
  private child: UtilityProcess | null = null
  private readonly listeners = new Set<(message: AgentWorkerEvent) => void>()

  private ensureChild(): UtilityProcess {
    if (this.child) return this.child
    const child = utilityProcess.fork(agentWorkerPath, [], { serviceName: "LG Agent" })
    child.on("message", (message) => {
      const event = message as AgentWorkerEvent
      if (event?.type !== "event") return
      for (const listener of this.listeners) listener(event)
    })
    child.on("exit", () => {
      this.child = null
    })
    this.child = child
    return child
  }

  onEvent(listener: (message: AgentWorkerEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  run(request: AgentRunRequest): void {
    this.ensureChild().postMessage(request)
  }

  cancel(requestId: string): void {
    this.child?.postMessage({ type: "cancel", requestId })
  }

  close(): void {
    this.child?.kill()
    this.child = null
  }
}
