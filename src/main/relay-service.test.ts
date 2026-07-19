import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ProjectRuntime } from "../core/project-runtime"
import { applyRelayResponse, createRelayPackage, inspectRelayResponse } from "./relay-service"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ runtime: ProjectRuntime; taskId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "lg-next-relay-"))
  roots.push(root)
  const runtime = new ProjectRuntime(root)
  await runtime.initialize()
  const task = await runtime.createTask("接力测试")
  await runtime.writeText({ path: "章节/第001章.md", content: "# 第一章\n\n雨还在下。\n" })
  return { runtime, taskId: task.id }
}

describe("official-site relay", () => {
  it("builds a source-backed package and applies an explicit append block", async () => {
    const { runtime, taskId } = await fixture()
    const relay = await createRelayPackage(runtime, {
      taskId,
      instruction: "继续这一章",
      activeDocumentPath: "章节/第001章.md",
    })
    expect(relay.content).toContain("主 Agent 选择的本地材料")
    expect(relay.content).toContain("雨还在下")
    expect(relay.sources).toHaveLength(1)
    expect(relay.estimatedTokens).toBeGreaterThan(0)
    const response = `<lg-write path="章节/第001章.md" mode="append">\n王扬推门进来。\n</lg-write>`
    const inspection = await inspectRelayResponse(runtime, relay.id, response)
    expect(inspection.canApply).toBe(true)
    expect(inspection.operations[0]).toMatchObject({ path: "章节/第001章.md", mode: "append" })

    const applied = await applyRelayResponse(runtime, relay.id, response)
    expect(applied.changedPaths).toEqual(["章节/第001章.md"])
    expect(applied.checkpoint).toBeTruthy()
    expect((await runtime.readText("章节/第001章.md")).content).toContain("王扬推门进来")
  })

  it("refuses a stale response after the target changed locally", async () => {
    const { runtime, taskId } = await fixture()
    const relay = await createRelayPackage(runtime, {
      taskId,
      instruction: "改写结尾",
      activeDocumentPath: "章节/第001章.md",
    })
    const snapshot = await runtime.readText("章节/第001章.md")
    await runtime.writeText({ path: snapshot.path, content: `${snapshot.content}\n本地新写了一句。\n`, expectedRevision: snapshot.revision })
    const response = `<lg-write path="章节/第001章.md" mode="replace">\n# 第一章\n\n官网版本。\n</lg-write>`
    const inspection = await inspectRelayResponse(runtime, relay.id, response)
    expect(inspection.canApply).toBe(false)
    expect(inspection.operations[0].issue).toContain("已经变化")
  })
})
