import { object } from "./quota"
import type { UsageRecord } from "./schema"

export type Attribution = Pick<UsageRecord, "accountID" | "accountLabel" | "sessionID" | "model" | "source">
const count = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0

export function responseUsage(payload: unknown, attribution: Attribution, now = Date.now()): UsageRecord | undefined {
  const event = object(payload)
  if (typeof event.type === "string" && !["response.completed", "response.incomplete", "response.failed"].includes(event.type)) return
  const response = object(event.response ?? event)
  const usage = object(response.usage)
  if (typeof response.id !== "string" || typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") return
  return {
    ...attribution,
    id: response.id,
    at: typeof response.created_at === "number" ? response.created_at * 1000 : now,
    model: typeof response.model === "string" ? response.model : attribution.model,
    input: count(usage.input_tokens),
    cached: count(object(usage.input_tokens_details).cached_tokens),
    output: count(usage.output_tokens),
    reasoning: count(object(usage.output_tokens_details).reasoning_tokens),
  }
}

// Consume a cloned stream incrementally; never retain or store assistant text.
// Limits protect the observer from non-SSE responses and oversized events.
export async function observeResponse(
  response: Response,
  attribution: Attribution,
  record: (value: UsageRecord) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const type = response.headers.get("content-type") ?? ""
  if (!response.body) return
  const reader = response.body.getReader()
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  const decoder = new TextDecoder()
  let buffer = ""
  const parse = async (text: string) => {
    let payload: unknown
    try { payload = JSON.parse(text) } catch { return }
    const usage = responseUsage(payload, attribution)
    if (usage) await record(usage)
  }
  try {
    if (!type.includes("text/event-stream") && !type.includes("application/json")) return
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > 4 * 1024 * 1024) throw new Error("Usage observer event limit exceeded")
      if (type.includes("text/event-stream")) {
        // Normalize CRLF even when the CR and LF fall in different chunks.
        let match: RegExpExecArray | null
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const block = buffer.slice(0, match.index)
          buffer = buffer.slice(match.index + match[0].length)
          const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")
          if (data && data !== "[DONE]") await parse(data)
        }
      }
    }
    buffer += decoder.decode()
    if (type.includes("application/json") && !signal.aborted) await parse(buffer)
  } finally {
    signal.removeEventListener("abort", abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
