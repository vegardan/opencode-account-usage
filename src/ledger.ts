import { createHash } from "node:crypto"
import type { Schema } from "effect"
import { RecordSchema, type UsageRecord, type Totals, type Range } from "./schema"

// Compatible with OpenCode's plugin-scoped durable JSON store.
export interface Storage {
  get(key: string): Promise<unknown>
  set(key: string, value: Schema.Json): Promise<void>
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<{
    entries: readonly { key: string; value: unknown }[]
    next?: string
  }>
}
export const hash = (value: string) => createHash("sha256").update(value).digest("hex")
export const emptyTotals = (): Totals => ({ requests: 0, input: 0, cached: 0, output: 0, reasoning: 0, total: 0 })
export function sum(records: UsageRecord[]): Totals {
  return records.reduce((t, r) => ({
    requests: t.requests + 1,
    input: t.input + r.input,
    cached: t.cached + r.cached,
    output: t.output + r.output,
    reasoning: t.reasoning + r.reasoning,
    // OpenAI's cached and reasoning counts are subsets, not extra tokens.
    total: t.total + r.input + r.output,
  }), emptyTotals())
}
export function cutoff(range: Range, now: number): number {
  return range === "all" ? 0 : now - ({ day: 1, week: 7, month: 30 }[range]) * 86_400_000
}
export class Ledger {
  constructor(private storage: Storage) {}
  async since() {
    const value = await this.storage.get("v1/since")
    if (typeof value === "number") return value
    const now = Date.now()
    await this.storage.set("v1/since", now)
    return now
  }
  async put(record: UsageRecord) {
    RecordSchema.parse(record)
    // One immutable response per key. Replayed frames and multiple location instances
    // overwrite the same key instead of incrementing counters twice.
    await this.storage.set(`v1/records/${hash(record.accountID + "/" + record.id)}`, record)
  }
  async records(range: Range, now = Date.now()) {
    const records: UsageRecord[] = []
    let after: string | undefined
    do {
      const page = await this.storage.scan({ prefix: "v1/records/", after, limit: 500 })
      for (const entry of page.entries) {
        const parsed = RecordSchema.safeParse(entry.value)
        if (parsed.success && parsed.data.at >= cutoff(range, now) && parsed.data.at <= now) records.push(parsed.data)
      }
      after = page.next
    } while (after)
    return records.sort((a, b) => b.at - a.at)
  }
}
function cell(value: string | number): string {
  const text = String(value)
  // Spreadsheet formula injection also applies to user-editable account labels.
  const safe = /^[=+\-@\t\r\n]/.test(text) ? `'${text}` : text
  return `"${safe.replaceAll('"', '""')}"`
}
export function csv(records: UsageRecord[]): string {
  return [
    ["UTC time", "Account", "Model", "Source", "Input (includes cached)", "Cached input", "Output (includes reasoning)", "Reasoning", "Total", "Session"].map(cell).join(","),
    ...records.map(r => [new Date(r.at).toISOString(), r.accountLabel, r.model, r.source, r.input, r.cached, r.output, r.reasoning, r.input + r.output, r.sessionID].map(cell).join(",")),
  ].join("\r\n")
}
