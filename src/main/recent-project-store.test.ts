import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { RecentProjectStore } from "./recent-project-store"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("RecentProjectStore", () => {
  it("keeps most recently opened projects first and removes missing folders", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lg-next-recent-"))
    roots.push(root)
    const first = path.join(root, "first")
    const second = path.join(root, "second")
    await Promise.all([mkdir(first), mkdir(second)])
    const store = new RecentProjectStore(path.join(root, "app-data", "recent.json"))

    await store.record({ path: first, name: "第一本" })
    await store.record({ path: second, name: "第二本" })
    await store.record({ path: first, name: "第一本（改名）" })
    expect((await store.list()).map((item) => item.name)).toEqual(["第一本（改名）", "第二本"])

    await rm(first, { recursive: true })
    expect((await store.list()).map((item) => item.name)).toEqual(["第二本"])
  })
})
