export interface RecallableMessage {
  id: string
  role: "user" | "assistant"
  content: string
  createdAt: string
}

export interface RecalledMessage extends RecallableMessage {
  score: number
  excerpt: string
}

const GENERIC = /^(继续|接着|接着写|往下写|然后呢|你决定|可以|是的|好|好的|ok|okay)[。.!！?？\s]*$/i

function queryTerms(value: string): string[] {
  const normalized = value.toLowerCase().replace(/\s+/g, " ")
  const groups = normalized.match(/[a-z0-9_]{2,}|[\u3400-\u9fff]+/g) ?? []
  const terms = new Set<string>()
  for (const group of groups) {
    if (group.length <= 8) terms.add(group)
    if (/^[\u3400-\u9fff]+$/.test(group)) {
      for (let index = 0; index < group.length - 1; index += 1) terms.add(group.slice(index, index + 2))
    }
  }
  return [...terms]
}

function excerptAround(content: string, terms: string[], maximum = 900): string {
  const compact = content.replace(/\s+/g, " ").trim()
  if (compact.length <= maximum) return compact
  const lower = compact.toLowerCase()
  const indexes = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0)
  const anchor = indexes.length ? Math.min(...indexes) : 0
  const start = Math.max(0, anchor - Math.floor(maximum / 3))
  return `${start ? "…" : ""}${compact.slice(start, start + maximum)}${start + maximum < compact.length ? "…" : ""}`
}

export function recallTaskHistory(input: {
  query: string
  candidates: RecallableMessage[]
  limit?: number
  maximumCharacters?: number
}): RecalledMessage[] {
  const query = input.query.trim()
  if (!query || GENERIC.test(query)) return []
  const terms = queryTerms(query)
  if (!terms.length) return []
  const lowerQuery = query.toLowerCase()
  const ranked = input.candidates.map((message, index) => {
    const haystack = message.content.toLowerCase()
    let score = haystack.includes(lowerQuery) ? 40 : 0
    for (const term of terms) {
      const occurrences = haystack.split(term).length - 1
      score += Math.min(occurrences, 4) * (term.length > 2 ? 4 : 1)
    }
    if (message.role === "user") score *= 1.2
    score += index / Math.max(1, input.candidates.length) * 0.5
    return { ...message, score, excerpt: excerptAround(message.content, terms) }
  }).filter((message) => message.score >= 2)
    .sort((left, right) => right.score - left.score)

  const output: RecalledMessage[] = []
  const maximum = Math.max(500, Math.min(input.maximumCharacters ?? 2800, 6000))
  let used = 0
  for (const message of ranked) {
    if (output.length >= (input.limit ?? 4) || used >= maximum) break
    const excerpt = message.excerpt.slice(0, maximum - used)
    if (!excerpt) break
    output.push({ ...message, excerpt })
    used += excerpt.length
  }
  return output
}
