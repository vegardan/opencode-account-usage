import { test } from "node:test"
import assert from "node:assert/strict"
import { parseQuota } from "../src/quota"
import { observeResponse, responseUsage, type Attribution } from "../src/capture"
import { Ledger, csv, sum, type Storage } from "../src/ledger"
import { SnapshotSchema } from "../src/schema"
import { Tracker } from "../src/tracker"
import type { Plugin } from "@opencode/plugin"
import { allowanceWindows, quotaIsStale, selectedAccount, usageButton } from "../src/gui/selected-account"
import type { Account } from "../src/schema"

class MemoryStorage implements Storage {
  values = new Map<string, unknown>()
  async get(key: string) { return this.values.get(key) }
  async set(key: string, value: unknown) { this.values.set(key, structuredClone(value)) }
  async scan({ prefix, after }: { prefix: string; after?: string }) {
    // Deliberately tiny pages to exercise cursors.
    const all = [...this.values.keys()].filter(k => k.startsWith(prefix) && (!after || k > after)).sort()
    const keys = all.slice(0, 2)
    return { entries: keys.map(key => ({ key, value: this.values.get(key) })), next: all.length > keys.length ? keys.at(-1) : undefined }
  }
}
const who: Attribution = { accountID: "a", accountLabel: "Account A", sessionID: "s", model: "gpt-test", source: "primary" }
const payload = (id: string) => ({
  type: "response.completed",
  response: { id, model: "gpt-test", usage: { input_tokens: 100, output_tokens: 30, input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 20 } } },
})
test("quota preserves unknowns, derives window labels from duration, handles additional limits", () => {
  const result = parseQuota({
    plan_type: "team",
    rate_limit: { allowed: false, primary_window: { used_percent: 110, limit_window_seconds: 604800, reset_at: 100 }, secondary_window: null },
    additional_rate_limits: [{ limit_name: "Spark", rate_limit: { primary_window: { used_percent: null, limit_window_seconds: 18000, reset_after_seconds: 20 } } }],
    credits: { balance: "4.20" },
  }, 1000)
  assert.equal(result.windows[0].label, "Codex · 7-day")
  assert.equal(result.windows[0].usedPercent, 100)
  assert.equal(result.windows[0].resetsAt, 100000)
  assert.equal(result.windows[1].label, "Spark · 5-hour")
  assert.equal(result.windows[1].usedPercent, null)
  assert.equal(result.windows[1].resetsAt, 21000)
  assert.equal(result.allowed, false)
  assert.equal(result.credits, "4.20")
  assert.throws(() => parseQuota({ error: "unauthorized" }))
})
test("ledger deduplicates across instances and pages without double counting token subsets", async () => {
  const store = new MemoryStorage()
  const first = new Ledger(store)
  const second = new Ledger(store)
  for (let i = 0; i < 5; i++) {
    const record = responseUsage(payload(String(i)), who, 1000)!
    await Promise.all([first.put(record), second.put(record)])
  }
  const records = await first.records("all", 2000)
  assert.equal(records.length, 5)
  assert.deepEqual(sum(records), { requests: 5, input: 500, output: 150, cached: 400, reasoning: 100, total: 650 })
  assert.equal((await first.records("day", 100000000)).length, 0)
  assert.equal(await first.since(), await second.since())
})
test("CSV escapes quotes and neutralizes spreadsheet formulas", () => {
  const record = responseUsage(payload("x"), { ...who, accountLabel: '=HYPERLINK("x")' }, 1000)!
  assert.match(csv([record]), /"'=HYPERLINK\(""x""\)"/)
})
test("SSE observation survives byte boundaries, ignores deltas, and preserves the original response", async () => {
  const raw = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "private text" })}\r\n\r\ndata: ${JSON.stringify(payload("r"))}\r\n\r\ndata: [DONE]\r\n\r\n`
  const bytes = new TextEncoder().encode(raw)
  const body = new ReadableStream<Uint8Array>({
    start(c) { for (const b of bytes) c.enqueue(Uint8Array.of(b)); c.close() },
  })
  const original = new Response(body, { headers: { "content-type": "text/event-stream" } })
  const records: unknown[] = []
  await observeResponse(original.clone(), who, async r => { records.push(r) }, new AbortController().signal)
  assert.equal(records.length, 1)
  assert.equal(await original.text(), raw)
  assert.ok(!JSON.stringify(records).includes("private text"))
})
test("JSON and incomplete Responses include reported usage; unknown protocols are not guessed", async () => {
  const incomplete = { ...payload("r"), type: "response.incomplete" }
  assert.equal(responseUsage(incomplete, who)?.output, 30)
  assert.equal(responseUsage({ choices: [], usage: { prompt_tokens: 999 } }, who), undefined)
  const found: unknown[] = []
  await observeResponse(new Response(JSON.stringify(payload("j").response), { headers: { "content-type": "application/json" } }), who, async r => { found.push(r) }, new AbortController().signal)
  assert.equal(found.length, 1)
})
test("observer abort cancels its reader", async () => {
  let cancelled = false
  const body = new ReadableStream({ cancel() { cancelled = true } })
  const controller = new AbortController()
  const task = observeResponse(new Response(body, { headers: { "content-type": "text/event-stream" } }), who, async () => {}, controller.signal)
  controller.abort()
  await task
  assert.ok(cancelled)
})
test("mixed Codex and ChatGPT accounts track separately; token-sharing credentials never reach the legacy endpoint", async t => {
  const hooks = new Map<string, (input: any) => any>()
  const store = new MemoryStorage()
  const connections = [
    { id: "a", type: "credential", label: "Account A", method: "oauth" },
    { id: "b", type: "credential", label: "Account B", method: "oauth" },
  ]
  const secretA = "TEST_ONLY_A", secretB = "TEST_ONLY_B"
  let activeIndex = 1
  const ctx = {
    storage: store,
    integration: {
      get: async () => ({ data: { connections } }),
      connection: {
        active: async () => connections[activeIndex],
        resolve: async (c: { id: string }) => ({
          type: "oauth", methodID: c.id === "a" ? "chatgpt-browser" : "chatgpt-token-sharing",
          access: c.id === "a" ? secretA : secretB, metadata: { accountID: `remote-${c.id}` },
        }),
      },
    },
    session: { hook: async (name: string, fn: (e: any) => any) => { hooks.set(name, fn) } },
    event: { subscribe: async function* () {} },
  } as unknown as Plugin.Context
  const originalFetch = globalThis.fetch
  const fetchedTokens: string[] = []
  globalThis.fetch = async (_input, options) => {
    const headers = new Headers(options?.headers)
    fetchedTokens.push(headers.get("authorization") ?? "")
    return new Response(JSON.stringify({ plan_type: "plus", rate_limit: { primary_window: { used_percent: headers.get("authorization")?.includes(secretA) ? 20 : 80, limit_window_seconds: 18000 } } }))
  }
  t.after(() => { globalThis.fetch = originalFetch })
  const tracker = new Tracker(ctx)
  await tracker.start()
  t.after(() => tracker.stop())
  await tracker.snapshot("all")
  for (const [id, secret] of [["a", secretA], ["b", secretB]]) {
    const event = { sessionID: `session-${id}`, model: { id: "gpt-test", providerID: "openai" }, kind: "primary", headers: { authorization: `Bearer ${secret}`, "chatgpt-account-id": `remote-${id}` } }
    await hooks.get("experimental.ws.handshake")!(event)
    await hooks.get("experimental.ws.receive")!({ ...event, frame: JSON.stringify(payload(`response-${id}`)) })
  }
  const snapshot = SnapshotSchema.parse(await tracker.snapshot("all"))
  assert.equal(snapshot.accounts[0].totals.total, 130)
  assert.equal(snapshot.accounts[1].totals.total, 130)
  assert.equal(snapshot.accounts[0].active, false)
  assert.equal(snapshot.accounts[1].active, true)
  assert.equal(snapshot.accounts[0].quota?.windows[0].usedPercent, 20)
  assert.equal(snapshot.accounts[1].quota, null)
  assert.equal(snapshot.accounts[1].status, "unsupported")
  assert.deepEqual(fetchedTokens, [`Bearer ${secretA}`])
  assert.ok(!JSON.stringify(snapshot).includes("TEST_ONLY"))
  // Selection must update even inside the provider's 60-second quota cache.
  activeIndex = 0
  const switched = await tracker.snapshot("all")
  assert.equal(selectedAccount(switched.accounts)?.id, "a")
  assert.deepEqual(fetchedTokens, [`Bearer ${secretA}`])
  const unknown = { sessionID: "unknown", model: { id: "gpt-test", providerID: "openai" }, kind: "primary", headers: { authorization: "Bearer unmatched" } }
  await hooks.get("experimental.ws.handshake")!(unknown)
  await hooks.get("experimental.ws.receive")!({ ...unknown, frame: JSON.stringify(payload("unknown")) })
  assert.equal((await tracker.snapshot("all")).totals.requests, 2)
})

test("top allowance uses only the connected selected account and keeps main Codex windows separate", () => {
  const quota = parseQuota({
    rate_limit: {
      primary_window: { used_percent: 50, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 8, limit_window_seconds: 604800 },
    },
    code_review_rate_limit: { primary_window: { used_percent: 99 } },
  }, 1000)
  const account: Account = {
    id: "selected", label: "Selected", active: true, connected: true,
    quota, totals: sum([]), status: "ok", error: null,
  }
  assert.equal(selectedAccount([{ ...account, id: "other", active: false }, account])?.id, "selected")
  assert.equal(selectedAccount([{ ...account, connected: false }]), undefined)
  assert.deepEqual(allowanceWindows(account).map(w => w.usedPercent), [50, 8])
  assert.deepEqual(allowanceWindows({ ...account, quota: null }), [])
  assert.equal(quotaIsStale(account, 1001), false)
  assert.equal(quotaIsStale(account, 121001), true)
  assert.equal(quotaIsStale({ ...account, status: "error" }, 1001), true)
})

test("sidebar button shows the most constrained Codex allowance, with all limits in its tooltip", () => {
  const account: Account = {
    id: "a", label: "OpenAI Test", active: true, connected: true,
    totals: sum([]), status: "ok", error: null,
    quota: parseQuota({
      rate_limit: {
        allowed: true,
        primary_window: { used_percent: 50, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 77, limit_window_seconds: 604800 },
      },
      code_review_rate_limit: { primary_window: { used_percent: 100 } },
    }, 1000),
  }
  const button = usageButton(account, 1001)
  assert.equal(button.label, "OpenAI Test · 23% left")
  assert.match(button.title, /OpenAI Test/)
  assert.match(button.title, /5-hour: 50% left/)
  assert.match(button.title, /7-day: 23% left/)
  assert.equal(usageButton(account, 121001).label, "OpenAI Test · 23% left · stale")
  assert.equal(usageButton(account, 1001, true).label, "OpenAI Test · 23% left · stale")
  assert.equal(usageButton({ ...account, quota: { ...account.quota!, allowed: false } }, 1001).label, "OpenAI Test · 0% left")
  assert.equal(usageButton({ ...account, quota: null }, 1001).label, "OpenAI Test · usage unavailable")
  assert.equal(usageButton({ ...account, label: "OpenAI Personal" }, 1001).label, "OpenAI Personal · 23% left")
  assert.equal(usageButton({ ...account, label: "OpenAI Work" }, 1001).label, "OpenAI Work · 23% left")
  assert.equal(usageButton({ ...account, label: " " }, 1001).label, "OpenAI · 23% left")
  assert.equal(usageButton(undefined, 1001).label, "OpenAI usage")
})
