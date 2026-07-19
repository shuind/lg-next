import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createAgentTools, type AgentTool } from "../../agent/tools"
import { ProjectRuntime } from "../project-runtime"
import type { TaskEvent } from "../../shared/contracts"

const temporaryRoots: string[] = []

async function temporaryProject(): Promise<{ root: string; runtime: ProjectRuntime }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "lg-next-agent-"))
  temporaryRoots.push(root)
  const runtime = new ProjectRuntime(root)
  await runtime.initialize()
  await runtime.createTask("测试任务")
  return { root, runtime }
}

function toolByName(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((candidate) => (
    candidate.definition.type === "function" && candidate.definition.function.name === name
  ))
  if (!tool) throw new Error(`Missing tool ${name}`)
  return tool
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Agent file tools", () => {
  it("writes new prose, requires revision for overwrite, and edits exact text", async () => {
    const { root, runtime } = await temporaryProject()
    const taskId = (await runtime.tasks.list())[0].id
    const tools = createAgentTools(root, { taskId, sourceTurnId: "request-1" })
    const write = toolByName(tools, "write_file")
    const edit = toolByName(tools, "edit_file")
    const storySearch = toolByName(tools, "search_story")
    const recordCorrection = toolByName(tools, "record_correction")

    const created = await write.execute({ path: "章节/第001章.md", content: "# 第一章\n\n故人将去。\n" })
    expect(created.ok).toBe(true)

    const refused = await write.execute({ path: "章节/第001章.md", content: "覆盖" })
    expect(refused.ok).toBe(false)
    expect(refused.content).toContain("expected_revision")

    const edited = await edit.execute({
      path: "章节/第001章.md",
      old_text: "故人将去",
      new_text: "故人已至",
    })
    expect(edited.ok).toBe(true)
    expect((await runtime.readText("章节/第001章.md")).content).toContain("故人已至")

    const recalled = await storySearch.execute({ query: "故人已至" })
    expect(recalled.ok).toBe(true)
    expect(recalled.content).toContain("故人已至")
    expect(recalled.content).toContain("startLine")

    const snapshot = await runtime.readText("章节/第001章.md")
    const correction = await recordCorrection.execute({
      user_text: "这里不对，他现在不会把自己说明白。",
      targets: [{ path: snapshot.path, revision: snapshot.revision, start_line: 3, end_line: 3 }],
      characters: ["故人"],
    }, { sourceTurnId: "request-1" })
    expect(correction.ok).toBe(true)
    expect((await runtime.corrections.list())[0].userText).toBe("这里不对，他现在不会把自己说明白。")
    expect((await runtime.mutations.ledger.list()).map((entry) => entry.operation)).toEqual(expect.arrayContaining(["create", "edit"]))
  })
})

describe("TaskEventStore", () => {
  it("keeps the latest state of one tool action", async () => {
    const { runtime } = await temporaryProject()
    const base = {
      id: "tool-event",
      taskId: (await runtime.tasks.list())[0].id,
      requestId: "request-1",
      createdAt: new Date().toISOString(),
      type: "tool" as const,
      name: "read_file",
      label: "读取第一章",
    }
    await runtime.events.append({ ...base, status: "running" })
    await runtime.events.append({ ...base, status: "completed", detail: "读取完成" })

    const events: TaskEvent[] = await runtime.events.list(base.taskId)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ id: "tool-event", status: "completed" })
  })
})
