import { app, safeStorage } from "electron"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import OpenAI from "openai"
import { z } from "zod"
import type { ModelConfig } from "../agent/protocol"
import type {
  ModelPricing,
  ModelRecordView,
  ModelSettingsInput,
  ModelSettingsView,
  ModelStatus,
  ModelTestResult,
} from "../shared/contracts"

const pricingSchema = z.object({
  currency: z.enum(["CNY", "USD"]),
  inputPerMillion: z.number().finite().nonnegative(),
  outputPerMillion: z.number().finite().nonnegative(),
  cacheReadPerMillion: z.number().finite().nonnegative(),
  cacheWritePerMillion: z.number().finite().nonnegative(),
})

const storedRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().min(1),
  baseUrl: z.url(),
  model: z.string().min(1),
  recentModels: z.array(z.string().min(1)).max(12).optional(),
  apiKey: z.string().min(1),
  apiKeyStorage: z.enum(["encrypted", "plain"]),
  pricing: pricingSchema,
  updatedAt: z.iso.datetime(),
})

const storedSettingsSchema = z.object({
  version: z.literal(2),
  activeRecordId: z.string().optional(),
  records: z.array(storedRecordSchema).max(50),
})

const legacySettingsSchema = z.object({
  version: z.literal(1),
  provider: z.string().min(1),
  baseUrl: z.url(),
  model: z.string().min(1),
  recentModels: z.array(z.string().min(1)).max(12).optional(),
  apiKey: z.string().min(1),
  apiKeyStorage: z.enum(["encrypted", "plain"]),
  updatedAt: z.iso.datetime(),
})

type StoredRecord = z.infer<typeof storedRecordSchema>
type StoredSettings = z.infer<typeof storedSettingsSchema>

const EMPTY_PRICING: ModelPricing = {
  currency: "CNY",
  inputPerMillion: 0,
  outputPerMillion: 0,
  cacheReadPerMillion: 0,
  cacheWritePerMillion: 0,
}

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
    const raw = JSON.parse(await readFile(settingsPath(), "utf8")) as unknown
    const current = storedSettingsSchema.safeParse(raw)
    if (current.success) return current.data
    const legacy = legacySettingsSchema.safeParse(raw)
    if (legacy.success) {
      const record: StoredRecord = {
        id: "legacy-model",
        name: legacy.data.provider === "openai-compatible" ? legacy.data.model : legacy.data.provider,
        provider: legacy.data.provider,
        baseUrl: legacy.data.baseUrl,
        model: legacy.data.model,
        recentModels: legacy.data.recentModels,
        apiKey: legacy.data.apiKey,
        apiKeyStorage: legacy.data.apiKeyStorage,
        pricing: { ...EMPTY_PRICING },
        updatedAt: legacy.data.updatedAt,
      }
      return { version: 2, activeRecordId: record.id, records: [record] }
    }
    throw current.error
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    console.error("Failed to read model settings", error)
    return null
  }
}

async function writeStored(settings: StoredSettings): Promise<void> {
  await mkdir(path.dirname(settingsPath()), { recursive: true })
  await writeFile(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
}

function decryptApiKey(record: StoredRecord): string {
  if (record.apiKeyStorage === "plain") return Buffer.from(record.apiKey, "base64").toString("utf8")
  return safeStorage.decryptString(Buffer.from(record.apiKey, "base64"))
}

function environmentConfig(): ModelConfig | null {
  const apiKey = process.env.LG_API_KEY ?? process.env.NG_API_KEY ?? process.env.DEEPSEEK_API_KEY
  const baseUrl = process.env.LG_BASE_URL ?? process.env.NG_BASE_URL
    ?? (process.env.DEEPSEEK_API_KEY ? "https://api.deepseek.com" : undefined)
  const model = process.env.LG_MODEL ?? process.env.NG_MODEL ?? process.env.DEEPSEEK_MODEL
    ?? (process.env.DEEPSEEK_API_KEY ? "deepseek-chat" : undefined)
  if (!apiKey || !baseUrl || !model) return null
  return {
    recordId: "environment",
    recordName: "环境变量",
    provider: process.env.LG_PROVIDER ?? process.env.NG_PROVIDER ?? "openai-compatible",
    apiKey,
    baseUrl,
    model,
    pricing: { ...EMPTY_PRICING },
  }
}

function activeStoredRecord(settings: StoredSettings | null): StoredRecord | null {
  if (!settings?.records.length) return null
  return settings.records.find((record) => record.id === settings.activeRecordId) ?? settings.records[0]
}

function recordConfig(record: StoredRecord): ModelConfig {
  return {
    recordId: record.id,
    recordName: record.name,
    provider: record.provider,
    apiKey: decryptApiKey(record),
    baseUrl: record.baseUrl.replace(/\/$/, ""),
    model: record.model,
    pricing: record.pricing,
  }
}

function recordView(record: StoredRecord): ModelRecordView {
  return {
    id: record.id,
    name: record.name,
    provider: record.provider,
    baseUrl: record.baseUrl,
    model: record.model,
    recentModels: availableModels(record.provider, record.baseUrl, record.model, record.recentModels),
    hasApiKey: true,
    source: "app",
    pricing: record.pricing,
    updatedAt: record.updatedAt,
  }
}

function environmentRecord(config: ModelConfig): ModelRecordView {
  return {
    id: "environment",
    name: "环境变量",
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    recentModels: availableModels(config.provider, config.baseUrl, config.model),
    hasApiKey: true,
    source: "environment",
    pricing: { ...EMPTY_PRICING },
  }
}

function emptySettings(): ModelSettingsView {
  return {
    records: [],
    provider: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    recentModels: ["deepseek-chat", "deepseek-reasoner"],
    hasApiKey: false,
    source: "none",
  }
}

function settingsView(records: ModelRecordView[], activeRecordId?: string): ModelSettingsView {
  const active = records.find((record) => record.id === activeRecordId) ?? records[0]
  if (!active) return emptySettings()
  return {
    activeRecordId: active.id,
    records,
    provider: active.provider,
    baseUrl: active.baseUrl,
    model: active.model,
    recentModels: active.recentModels,
    hasApiKey: active.hasApiKey,
    source: active.source,
  }
}

function normalizedUrl(value: string): string {
  const parsed = new URL(value.trim())
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Base URL 只支持 http 或 https")
  return parsed.toString().replace(/\/$/, "")
}

function normalizedPricing(pricing: ModelPricing): ModelPricing {
  return pricingSchema.parse(pricing)
}

export async function loadModelConfig(): Promise<ModelConfig | null> {
  const record = activeStoredRecord(await readStored())
  if (record) {
    try {
      return recordConfig(record)
    } catch (error) {
      console.error("Failed to decrypt model API key", error)
    }
  }
  return environmentConfig()
}

export async function modelSettings(): Promise<ModelSettingsView> {
  const stored = await readStored()
  if (stored?.records.length) return settingsView(stored.records.map(recordView), stored.activeRecordId)
  const environment = environmentConfig()
  if (environment) return settingsView([environmentRecord(environment)], "environment")
  return emptySettings()
}

export async function saveModelSettings(input: ModelSettingsInput): Promise<ModelSettingsView> {
  const name = input.name.trim()
  const provider = input.provider.trim() || "openai-compatible"
  const baseUrl = normalizedUrl(input.baseUrl)
  const model = input.model.trim()
  if (!name) throw new Error("记录名称不能为空")
  if (!model) throw new Error("模型名称不能为空")

  const stored = await readStored() ?? { version: 2 as const, records: [] }
  const existing = input.id && input.id !== "environment"
    ? stored.records.find((record) => record.id === input.id)
    : undefined
  let apiKey = input.apiKey?.trim()
  if (!apiKey && existing) apiKey = decryptApiKey(existing)
  if (!apiKey && input.id === "environment") apiKey = environmentConfig()?.apiKey
  if (!apiKey) throw new Error("API Key 不能为空")

  const encrypted = safeStorage.isEncryptionAvailable()
  const id = existing?.id ?? randomUUID()
  const updatedAt = new Date().toISOString()
  const record: StoredRecord = {
    id,
    name,
    provider,
    baseUrl,
    model,
    recentModels: availableModels(provider, baseUrl, model, existing?.recentModels),
    apiKey: encrypted ? safeStorage.encryptString(apiKey).toString("base64") : Buffer.from(apiKey, "utf8").toString("base64"),
    apiKeyStorage: encrypted ? "encrypted" : "plain",
    pricing: normalizedPricing(input.pricing),
    updatedAt,
  }
  const records = existing
    ? stored.records.map((item) => item.id === existing.id ? record : item)
    : [...stored.records, record]
  const next: StoredSettings = { version: 2, activeRecordId: id, records }
  await writeStored(next)
  return settingsView(records.map(recordView), id)
}

export async function activateModelRecord(recordId: string): Promise<ModelSettingsView> {
  const stored = await readStored()
  if (!stored?.records.some((record) => record.id === recordId)) throw new Error("API 记录不存在")
  const next: StoredSettings = { ...stored, activeRecordId: recordId }
  await writeStored(next)
  return settingsView(next.records.map(recordView), recordId)
}

export async function deleteModelRecord(recordId: string): Promise<ModelSettingsView> {
  const stored = await readStored()
  if (!stored?.records.some((record) => record.id === recordId)) throw new Error("API 记录不存在")
  const records = stored.records.filter((record) => record.id !== recordId)
  const activeRecordId = stored.activeRecordId === recordId ? records[0]?.id : stored.activeRecordId
  await writeStored({ version: 2, activeRecordId, records })
  if (records.length) return settingsView(records.map(recordView), activeRecordId)
  const environment = environmentConfig()
  return environment ? settingsView([environmentRecord(environment)], "environment") : emptySettings()
}

export async function modelStatus(): Promise<ModelStatus> {
  const [config, settings] = await Promise.all([loadModelConfig(), modelSettings()])
  const active = settings.records.find((record) => record.id === settings.activeRecordId)
  return config
    ? { configured: true, recordId: active?.id, recordName: active?.name, provider: config.provider, model: config.model, baseUrl: config.baseUrl, source: settings.source }
    : { configured: false, source: "none" }
}

export async function testModel(input?: ModelSettingsInput): Promise<ModelTestResult> {
  let config: ModelConfig | null
  if (input) {
    const stored = await readStored()
    const existing = input.id && input.id !== "environment"
      ? stored?.records.find((record) => record.id === input.id)
      : undefined
    config = {
      provider: input.provider.trim() || "openai-compatible",
      baseUrl: normalizedUrl(input.baseUrl),
      model: input.model.trim(),
      apiKey: input.apiKey?.trim()
        || (existing ? decryptApiKey(existing) : undefined)
        || (input.id === "environment" ? environmentConfig()?.apiKey : undefined)
        || "",
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
