import { describe, expect, it } from "vitest"
import { recallTaskHistory, type RecallableMessage } from "./history-recall"

const messages: RecallableMessage[] = [
  { id: "1", role: "assistant", createdAt: "2026-01-01T00:00:00.000Z", content: "可以建立人物卡，记录人物的稳定性格。" },
  { id: "2", role: "user", createdAt: "2026-01-02T00:00:00.000Z", content: "不要把巴东王归纳成人物卡，我在意的是他能以意想不到却合理的方式存在。" },
  { id: "3", role: "assistant", createdAt: "2026-01-03T00:00:00.000Z", content: "下一步会继续写郡狱中的相见。" },
]

describe("recallTaskHistory", () => {
  it("recalls exact older user wording for a specific later question", () => {
    const recalled = recallTaskHistory({ query: "之前关于巴东王和人物卡是怎么说的？", candidates: messages })
    expect(recalled[0]).toMatchObject({ id: "2", role: "user" })
    expect(recalled[0].excerpt).toContain("意想不到却合理")
  })

  it("does not invent a historical route for a generic continuation", () => {
    expect(recallTaskHistory({ query: "继续", candidates: messages })).toEqual([])
  })

  it("obeys the recall character budget", () => {
    const recalled = recallTaskHistory({ query: "人物卡", candidates: messages, maximumCharacters: 20 })
    expect(recalled.reduce((sum, item) => sum + item.excerpt.length, 0)).toBeLessThanOrEqual(500)
  })
})
