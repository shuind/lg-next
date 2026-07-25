import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { AtomicTextStore } from "../atomic-text-store"
import { resolveInside } from "../paths"
import { ProjectRuntime } from "../project-runtime"

const temporaryRoots: string[] = []

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "lg-next-"))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("project paths", () => {
  it("rejects paths outside the book", async () => {
    const root = await temporaryProject()
    expect(() => resolveInside(root, "../outside.md")).toThrow("路径超出作品目录")
    expect(() => resolveInside(root, path.resolve(root, "absolute.md"))).toThrow("相对路径")
  })
})

describe("AtomicTextStore", () => {
  it("detects a stale write and preserves newer content", async () => {
    const root = await temporaryProject()
    const store = new AtomicTextStore(root)
    const first = await store.write({ path: "章节/第001章.md", content: "第一版" })
    await store.write({ path: "章节/第001章.md", content: "第二版", expectedRevision: first.revision })

    await expect(store.write({
      path: "章节/第001章.md",
      content: "过期覆盖",
      expectedRevision: first.revision,
    })).rejects.toThrow("文件已变化")

    expect((await store.read("章节/第001章.md")).content).toBe("第二版")
  })
})

describe("ProjectRuntime", () => {
  it("creates a minimal portable shell and defers tasks, index, and Git", async () => {
    const parent = await temporaryProject()
    const project = await ProjectRuntime.createBook(parent, "我的书")
    const root = project.path
    const runtime = new ProjectRuntime(root)

    expect(project.tasks).toHaveLength(0)
    expect(project.lifecycle).toBe("shell")
    expect(await readFile(path.join(root, "NOVEL.md"), "utf8")).toContain("format: lg-novel")
    expect(await runtime.listMarkdown()).toEqual(["NOVEL.md"])
    await expect(access(path.join(root, ".git"))).rejects.toThrow()
    await expect(access(path.join(root, ".lg", "tasks"))).rejects.toThrow()
    await expect(access(path.join(root, ".lg", "index"))).rejects.toThrow()

    await runtime.createTask("第一句话")
    expect(await runtime.tasks.list()).toHaveLength(1)
    await expect(access(path.join(root, ".git"))).rejects.toThrow()
    await expect(access(path.join(root, ".lg", "index"))).rejects.toThrow()

    const result = await runtime.writeText({
      path: "章节正文/第001章.md",
      content: "# 第一章\n\n故事从这里开始。\n",
    }, "写入第一章")

    expect(result.checkpoint.created).toBe(true)
    expect(result.checkpoint.commit).toMatch(/^[a-f0-9]{40}$/)
    const markdownFiles = await runtime.listMarkdown()
    expect(markdownFiles).toHaveLength(2)
    expect(markdownFiles).toEqual(expect.arrayContaining(["NOVEL.md", "章节正文/第001章.md"]))
    const versions = await runtime.versions.list()
    expect(versions.map((version) => version.label)).toEqual(["写入第一章", "初始版本"])
    expect(versions[0].files).toEqual([{ status: "A", path: "章节正文/第001章.md" }])
    const change = await runtime.versions.diff(result.checkpoint.commit!)
    expect(change).toContain("故事从这里开始")
    expect(change).not.toContain("NOVEL.md")
    expect(change).not.toContain(".gitignore")
  })

  it("loads a Markdown folder without changing it", async () => {
    const root = await temporaryProject()
    await writeFile(path.join(root, "正文.md"), "# 原有作品\n", "utf8")
    const before = await readdir(root)

    const project = await new ProjectRuntime(root).load()

    expect(project).toMatchObject({ name: path.basename(root), sourceKind: "markdown-folder", lifecycle: "external", tasks: [] })
    expect(await readdir(root)).toEqual(before)
  })

  it("recognizes a portable copy from NOVEL.md without runtime metadata", async () => {
    const parent = await temporaryProject()
    const created = await ProjectRuntime.createBook(parent, "带走的书")
    await rm(path.join(created.path, ".lg"), { recursive: true })

    const reopened = await new ProjectRuntime(created.path).load()

    expect(reopened).toMatchObject({ name: "带走的书", sourceKind: "portable-book", lifecycle: "external" })
    await expect(access(path.join(created.path, ".lg"))).rejects.toThrow()
  })

  it("lists readable versions, shows their patch, and restores forward without resetting history", async () => {
    const root = await temporaryProject()
    const runtime = new ProjectRuntime(root)
    await runtime.initialize()
    const first = await runtime.writeText({ path: "章节/第001章.md", content: "# 第一章\n\n第一版。\n" }, "写第一版")
    const second = await runtime.writeText({ path: "章节/第001章.md", content: "# 第一章\n\n第二版。\n", expectedRevision: (await runtime.readText("章节/第001章.md")).revision }, "写第二版")

    const versions = await runtime.versions.list()
    expect(versions[0]).toMatchObject({ commit: second.checkpoint.commit, label: "写第二版" })
    expect(versions[0].files).toContainEqual({ status: "M", path: "章节/第001章.md" })
    expect(await runtime.versions.diff(second.checkpoint.commit!)).toContain("第二版")

    const restored = await runtime.restoreVersion(first.checkpoint.commit!, "写第一版")
    expect(restored.created).toBe(true)
    expect((await runtime.readText("章节/第001章.md")).content).toContain("第一版")
    expect((await runtime.versions.list())[0].label).toBe("恢复到：写第一版")
  })

  it("serializes competing mutations and rejects the stale writer", async () => {
    const root = await temporaryProject()
    const runtime = new ProjectRuntime(root)
    await runtime.initialize()
    const first = await runtime.writeText({ path: "章节/第001章.md", content: "第一版" })
    const results = await Promise.allSettled([
      runtime.mutations.apply({ path: first.path, beforeRevision: first.revision, afterContent: "并发甲", actor: "agent" }),
      runtime.mutations.apply({ path: first.path, beforeRevision: first.revision, afterContent: "并发乙", actor: "agent" }),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect(["并发甲", "并发乙"]).toContain((await runtime.readText(first.path)).content)
  })

  it("summarizes local writing and Agent usage without counting the portable manifest", async () => {
    const parent = await temporaryProject()
    const created = await ProjectRuntime.createBook(parent, "统计测试")
    const runtime = new ProjectRuntime(created.path)
    const task = await runtime.createTask("继续写")
    await runtime.writeText({ path: "章节正文/第001章.md", content: "# 第一章\n\n一二三四五。\n" })
    const createdAt = new Date().toISOString()

    await runtime.events.append({ id: "event-user", taskId: task.id, requestId: "request-1", type: "user_message", createdAt, text: "继续" })
    await runtime.events.append({ id: "event-assistant", taskId: task.id, requestId: "request-1", type: "assistant_message", createdAt, text: "已完成" })
    await runtime.events.append({
      id: "event-done",
      taskId: task.id,
      requestId: "request-1",
      type: "done",
      createdAt,
      changedPaths: ["章节正文/第001章.md"],
      usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
    })

    const stats = await runtime.usageStats()
    expect(stats).toMatchObject({
      projectName: "统计测试",
      taskCount: 1,
      messageCount: 2,
      runCount: 1,
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
      changedFileCount: 1,
      activeDayCount: 1,
    })
    expect(stats.characterCount).toBe("#第一章一二三四五。".length)
    expect(stats.daily.at(-1)).toMatchObject({ runs: 1, tokens: 150 })
  })

  it("lists individual API calls newest first with cache and cost details", async () => {
    const root = await temporaryProject()
    const runtime = new ProjectRuntime(root)
    await runtime.initialize()
    const task = await runtime.createTask("调用记录")
    const base = {
      taskId: task.id,
      requestId: "request-api",
      type: "api_call" as const,
      status: "succeeded" as const,
      kind: "agent" as const,
      finishedAt: "2026-07-20T10:00:01.000Z",
      provider: "openai-compatible",
      baseUrl: "https://relay.example/v1",
      model: "model-a",
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 600,
      cacheWriteInputTokens: 0,
      totalTokens: 1200,
      latencyMs: 800,
      currency: "CNY" as const,
      cost: 0.0024,
      requestBody: JSON.stringify({ model: "model-a", messages: [{ role: "user", content: "继续" }] }),
    }
    await runtime.events.append({ ...base, id: "api-old", createdAt: "2026-07-20T10:00:00.000Z" })
    await runtime.events.append({ ...base, id: "api-new", createdAt: "2026-07-20T11:00:00.000Z", finishedAt: "2026-07-20T11:00:01.000Z" })

    const calls = await runtime.apiCallRecords()
    expect(calls.map((call) => call.id)).toEqual(["api-new", "api-old"])
    expect(calls[0]).toMatchObject({ cachedInputTokens: 600, cost: 0.0024, latencyMs: 800 })
    expect(JSON.parse(calls[0].requestBody!)).toMatchObject({ model: "model-a" })
  })
})
