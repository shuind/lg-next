import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const electron = vi.hoisted(() => ({ userData: "" }))

vi.mock("electron", () => ({
  app: { getPath: () => electron.userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
}))

import {
  activateModelRecord,
  deleteModelRecord,
  loadModelConfig,
  modelSettings,
  saveModelSettings,
} from "./model-config"

const roots: string[] = []
const pricing = {
  currency: "CNY" as const,
  inputPerMillion: 2,
  outputPerMillion: 8,
  cacheReadPerMillion: 0.2,
  cacheWritePerMillion: 2.4,
}

beforeEach(async () => {
  electron.userData = await mkdtemp(path.join(os.tmpdir(), "lg-next-models-"))
  roots.push(electron.userData)
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("model config records", () => {
  it("stores independent records and switches the active connection", async () => {
    const first = await saveModelSettings({
      name: "主站",
      provider: "openai-compatible",
      baseUrl: "https://one.example/v1",
      model: "model-one",
      apiKey: "key-one",
      pricing,
    })
    const firstId = first.activeRecordId!
    const second = await saveModelSettings({
      name: "备用站",
      provider: "openai-compatible",
      baseUrl: "https://two.example/v1",
      model: "model-two",
      apiKey: "key-two",
      pricing: { ...pricing, currency: "USD", inputPerMillion: 0.5 },
    })

    expect(second.records).toHaveLength(2)
    expect(second.records[1].pricing).toMatchObject({ currency: "USD", inputPerMillion: 0.5 })
    expect((await loadModelConfig())?.apiKey).toBe("key-two")

    const activated = await activateModelRecord(firstId)
    expect(activated.activeRecordId).toBe(firstId)
    expect((await loadModelConfig())?.model).toBe("model-one")

    const remaining = await deleteModelRecord(firstId)
    expect(remaining.records.map((record) => record.name)).toEqual(["备用站"])
    expect((await loadModelConfig())?.apiKey).toBe("key-two")
  })

  it("reads version 1 settings as the first API record and migrates on save", async () => {
    await mkdir(electron.userData, { recursive: true })
    await writeFile(path.join(electron.userData, "model-settings.json"), JSON.stringify({
      version: 1,
      provider: "openai-compatible",
      baseUrl: "https://legacy.example/v1",
      model: "legacy-model",
      recentModels: ["legacy-model"],
      apiKey: Buffer.from("legacy-key", "utf8").toString("base64"),
      apiKeyStorage: "encrypted",
      updatedAt: "2026-07-20T00:00:00.000Z",
    }))

    const legacy = await modelSettings()
    expect(legacy.records).toHaveLength(1)
    expect(legacy.records[0]).toMatchObject({ id: "legacy-model", model: "legacy-model", pricing: { inputPerMillion: 0 } })
    await saveModelSettings({
      id: legacy.records[0].id,
      name: "旧站点",
      provider: legacy.records[0].provider,
      baseUrl: legacy.records[0].baseUrl,
      model: legacy.records[0].model,
      pricing,
    })
    expect(JSON.parse(await readFile(path.join(electron.userData, "model-settings.json"), "utf8")).version).toBe(2)
    expect((await loadModelConfig())?.apiKey).toBe("legacy-key")
  })
})
