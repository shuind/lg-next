import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ProjectRuntime } from "../project-runtime"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("StoryIndex", () => {
  it("returns source-backed passages and follows later prose edits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lg-next-index-"))
    roots.push(root)
    const runtime = new ProjectRuntime(root)
    await runtime.initialize()

    await runtime.writeText({ path: "章节/第001章.md", content: "# 雨夜\n\n王扬没有回头。\n\n巴东王在门后笑了一声。\n" })
    await runtime.writeText({ path: "章节/第002章.md", content: "# 次日\n\n城门仍然紧闭。\n" })
    const manifestPath = path.join(root, ".lg", "index", "story", "manifest.json")
    const beforeManifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files: Record<string, { indexedAt: string }> }
    const first = await runtime.storyIndex.search("巴东王 门后")
    expect(first[0]).toMatchObject({ path: "章节/第001章.md", heading: "雨夜" })
    expect(first[0].startLine).toBeGreaterThan(0)
    expect(first[0].excerpt).toContain("巴东王")

    const snapshot = await runtime.readText("章节/第001章.md")
    await runtime.writeText({
      path: snapshot.path,
      expectedRevision: snapshot.revision,
      content: snapshot.content.replace("笑了一声", "忽然沉默"),
    })
    const afterManifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files: Record<string, { indexedAt: string }> }
    expect(afterManifest.files["章节/第002章.md"].indexedAt).toBe(beforeManifest.files["章节/第002章.md"].indexedAt)
    expect(await runtime.storyIndex.search("忽然沉默")).toHaveLength(1)
    expect(await runtime.storyIndex.search("笑了一声")).toHaveLength(0)
    expect((await runtime.storyIndex.status()).state).toBe("ready")
  })
})
