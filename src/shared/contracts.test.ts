import { describe, expect, it } from "vitest"
import { agentEventSchema } from "./contracts"

describe("agentEventSchema", () => {
  it("accepts a verifiable tool event", () => {
    const event = agentEventSchema.parse({
      id: "event-1",
      type: "tool",
      createdAt: "2026-07-18T12:00:00.000Z",
      label: "读取章节正文/第452章.md",
      status: "completed",
    })

    expect(event.type).toBe("tool")
  })

  it("rejects a tool event without status", () => {
    expect(() => agentEventSchema.parse({
      id: "event-2",
      type: "tool",
      createdAt: "2026-07-18T12:00:00.000Z",
      label: "写入正式章节",
    })).toThrow()
  })
})

