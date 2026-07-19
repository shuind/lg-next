import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { estimateMessageTokens, microcompactToolResults, MICROCOMPACTION_PREFIX } from "./compaction"
import { AgentSessionStore } from "./session-store"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Agent session continuity", () => {
  it("persists task messages and compaction boundaries atomically", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lg-next-session-"))
    roots.push(root)
    const store = new AgentSessionStore(root)
    await store.save({
      version: 1,
      taskId: "task-1",
      updatedAt: new Date().toISOString(),
      messages: [{ role: "user", content: "不要把人物压成人物卡。" }],
      boundaries: [],
    })
    expect((await store.load("task-1"))?.messages[0]).toMatchObject({ role: "user", content: "不要把人物压成人物卡。" })
  })

  it("microcompacts old mechanical tool output while preserving recent raw messages", () => {
    const oldOutput = "原文".repeat(1800)
    const messages = [
      { role: "assistant" as const, content: null, tool_calls: [{ id: "call-1", type: "function" as const, function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool" as const, tool_call_id: "call-1", content: oldOutput },
      ...Array.from({ length: 20 }, (_, index) => ({ role: "user" as const, content: `最近消息 ${index}` })),
    ]
    const before = estimateMessageTokens(messages)
    const compacted = microcompactToolResults(messages)
    expect(compacted.changed).toBe(1)
    expect(String(compacted.messages[1].content)).toContain(MICROCOMPACTION_PREFIX)
    expect(estimateMessageTokens(compacted.messages)).toBeLessThan(before)
    expect(compacted.messages.at(-1)?.content).toBe("最近消息 19")
  })
})
