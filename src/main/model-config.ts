import { app, safeStorage } from "electron"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import OpenAI from "openai"
import { z } from "zod"
import type { ModelConfig } from "../agent/protocol"
import type { ModelSettingsInput, ModelSettingsView, ModelStatus, ModelTestResult } from "../shared/contracts"

const storedSettingsSchema = z.object({
  version: z.literal(1),
  provider: z.string().min(1),
  baseUrl: z.url(),
  model: z.string().min(1),
  recentModels: z.array(z.string().min(1)).max(12).optional(),
  apiKey: z.string().min(1),
  apiKeyStorage: z.enum(["encrypted", "plain"]),
  updatedAt: z.iso.datetime(),
})

type StoredSettings = z.infer<typeof storedSettingsSchema>

function availableModels(provider: string, baseUrl: string, model: string, recentModels: string[] = []): string[] {
  const candidates = [model, ...recentModels]
  if (/deepseek/i.test(`${provider} ${baseUrl} ${model}`)) candidates.push("deepseek-chat", "deepseek-reasoner")
  return [...new Set(candidates.map((item) => item.trim()).filter(Boolean))].slice(0, 8)
}

function settingsPath(): string {
  return path.join(app.getPath("userData"), "model-settings.json")
}

async function readStored(): Promise<StoredSettings | null> {
  try {
    return storedSettingsSchema.parse(JSON.parse(await readFile(settingsPath(), "utf8")) as unknown)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    console.error("Failed to read model settings", error)
    return null
  }
}

function decryptApiKey(settings: StoredSettings): string {
  if (settings.apiKeyStorage === "plain") return Buffer.from(settings.apiKey, "base64").toString("utf8")
  return safeStorage.decryptString(Buffer.from(settings.apiKey, "base64"))
}

function environmentConfig(): ModelConfig | null {
  const apiKey = process.env.LG_API_KEY ?? process.env.NG_API_KEY ?? process.env.DEEPSEEK_API_KEY
  const baseUrl = process.env.LG_BASE_URL ?? process.env.NG_BASE_URL
    ?? (process.env.DEEPSEEK_API_KEY ? "https://api.deepseek.com" : undefined)
  const model = process.env.LG_MODEL ?? process.env.NG_MODEL ?? process.env.DEEPSEEK_MODEL
    ?? (process.env.DEEPSEEK_API_KEY ? "deepseek-chat" : undefined)
  if (!apiKey || !baseUrl || !model) return null
  return { provider: process.env.LG_PROVIDER ?? process.env.NG_PROVIDER ?? "openai-compatible", apiKey, baseUrl, model }
}

export async function loadModelConfig(): Promise<ModelConfig | null> {
  const stored = await readStored()
  if (stored) {
    try {
      return {
        provider: stored.provider,
        apiKey: decryptApiKey(stored),
        baseUrl: stored.baseUrl.replace(/\/$/, ""),
        model: stored.model,
      }
    } catch (error) {
      console.error("Failed to decrypt model API key", error)
    }
  }
  return environmentConfig()
}

export async function modelSettings(): Promise<ModelSettingsView> {
  const stored = await readStored()
  if (stored) return {
    provider: stored.provider,
    baseUrl: stored.baseUrl,
    model: stored.model,
    recentModels: availableModels(stored.provider, stored.baseUrl, stored.model, stored.recentModels),
    hasApiKey: true,
    source: "app",
  }
  const environment = environmentConfig()
  if (environment) return {
    provider: environment.provider,
    baseUrl: environment.baseUrl,
    model: environment.model,
    recentModels: availableModels(environment.provider, environment.baseUrl, environment.model),
    hasApiKey: true,
    source: "environment",
  }
  return { provider: "openai-compatible", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", recentModels: ["deepseek-chat", "deepseek-reasoner"], hasApiKey: false, source: "none" }
}

export async function saveModelSettings(input: ModelSettingsInput): Promise<ModelSettingsView> {
  const provider = input.provider.trim() || "openai-compatible"
  const baseUrl = new URL(input.baseUrl.trim()).toString().replace(/\/$/, "")
  const model = input.model.trim()
  if (!model) throw new Error("模型名称不能为空")
  const existing = await readStored()
  const current = await loadModelConfig()
  let apiKey = input.apiKey?.trim()
  if (!apiKey) apiKey = current?.apiKey
  if (!apiKey) throw new Error("API Key 不能为空")
  const encrypted = safeStorage.isEncryptionAvailable()
  const encoded = encrypted
    ? safeStorage.encryptString(apiKey).toString("base64")
    : Buffer.from(apiKey, "utf8").toString("base64")
  const settings: StoredSettings = {
    version: 1,
    provider,
    baseUrl,
    model,
    recentModels: availableModels(provider, baseUrl, model, existing?.recentModels),
    apiKey: encoded,
    apiKeyStorage: encrypted ? "encrypted" : "plain",
    updatedAt: new Date().toISOString(),
  }
  await mkdir(path.dirname(settingsPath()), { recursive: true })
  await writeFile(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  return { provider, baseUrl, model, recentModels: availableModels(provider, baseUrl, model, settings.recentModels), hasApiKey: true, source: "app" }
}

export async function modelStatus(): Promise<ModelStatus> {
  const [config, settings] = await Promise.all([loadModelConfig(), modelSettings()])
  return config
    ? { configured: true, provider: config.provider, model: config.model, baseUrl: config.baseUrl, source: settings.source }
    : { configured: false, source: "none" }
}

export async function testModel(input?: ModelSettingsInput): Promise<ModelTestResult> {
  let config: ModelConfig | null
  if (input) {
    const existing = await loadModelConfig()
    config = {
      provider: input.provider.trim() || "openai-compatible",
      baseUrl: new URL(input.baseUrl.trim()).toString().replace(/\/$/, ""),
      model: input.model.trim(),
      apiKey: input.apiKey?.trim() || existing?.apiKey || "",
    }
  } else {
    config = await loadModelConfig()
  }
  if (!config?.apiKey || !config.model) throw new Error("请先填写完整的模型设置")
  const startedAt = Date.now()
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl, timeout: 20_000, maxRetries: 0 })
  const response = await client.chat.completions.create({
    model: config.model,
    messages: [{ role: "user", content: "只回复 OK" }],
    max_tokens: 4,
  })
  return { ok: true, latencyMs: Date.now() - startedAt, reply: response.choices[0]?.message.content?.trim() || "连接成功" }
}
