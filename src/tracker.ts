import type { Plugin } from "@opencode/plugin"
import { Ledger, csv, emptyTotals, hash, sum } from "./ledger"
import { fetchQuota, object, tokenAccountID } from "./quota"
import { observeResponse, responseUsage, type Attribution } from "./capture"
import type { Account, Range, Snapshot } from "./schema"

type Identity = { id: string; label: string; accountID?: string; fingerprint: string }
type RequestContext = { sessionID: string; model: { id: string; providerID: string }; kind: string }
export class Tracker {
  private ledger: Ledger
  private controller = new AbortController()
  private identities: Identity[] = []
  private accounts: Account[] = []
  private refreshedAt = 0
  private identityLookupAt = 0
  private refreshing?: Promise<void>
  private sockets = new Map<string, Attribution>()
  private pending = new Set<Promise<void>>()
  private notice: string | null = null
  private stopped = false
  constructor(private ctx: Plugin.Context) {
    this.ledger = new Ledger(ctx.storage)
  }
  async start() {
    await this.ledger.since()
    const safely = (task: Promise<void>) => {
      const running = task.catch(() => {
        if (!this.stopped) this.notice = "Some token usage could not be recorded. Counts may be incomplete."
      }).finally(() => this.pending.delete(running))
      this.pending.add(running)
    }
    await this.ctx.session.hook("http.response", async event => {
      if (event.model.providerID !== "openai" || !event.response.ok) return
      try {
        const who = await this.identify(event.request.headers, event)
        if (!who) return
        safely(observeResponse(event.response.clone(), who, r => this.ledger.put(r), this.controller.signal))
      } catch {
        this.notice = "A response could not be attributed; it was omitted from account totals."
      }
    }, { providerID: "openai" })
    await this.ctx.session.hook("experimental.ws.handshake", async event => {
      const key = `${event.sessionID}/${event.kind}`
      this.sockets.delete(key)
      try {
        const who = await this.identify(new Headers(event.headers), event)
        if (who) this.sockets.set(key, who)
      } catch {
        this.notice = "A WebSocket request could not be attributed; it was omitted from account totals."
      }
    }, { providerID: "openai" })
    await this.ctx.session.hook("experimental.ws.receive", event => {
      const who = this.sockets.get(`${event.sessionID}/${event.kind}`)
      if (!who || !/response\.(completed|incomplete|failed)/.test(event.frame)) return
      try {
        const record = responseUsage(JSON.parse(event.frame), who)
        if (record) safely(this.ledger.put(record))
      } catch {
        this.notice = "A WebSocket usage result could not be read."
      }
    }, { providerID: "openai" })
    // Cleanup attribution when sessions terminate, and invalidate account labels on changes.
    safely((async () => {
      for await (const event of this.ctx.event.subscribe({
        types: ["credential.updated", "credential.switched", "session.idle", "session.deleted"],
        signal: this.controller.signal,
      })) {
        if (event.type.startsWith("credential.")) this.refreshedAt = 0
        else if ("sessionID" in event.data) {
          for (const key of this.sockets.keys()) if (key.startsWith(`${event.data.sessionID}/`)) this.sockets.delete(key)
        }
      }
    })())
    // Do not block plugin loading on the provider's usage service.
    safely(this.refresh())
  }
  async stop() {
    this.stopped = true
    this.controller.abort()
    this.sockets.clear()
    await Promise.allSettled([...this.pending])
  }
  private refresh(force = false): Promise<void> {
    if (this.refreshing) return this.refreshing
    if (!force && Date.now() - this.refreshedAt < 60_000) return Promise.resolve()
    this.refreshing = this.loadAccounts().catch(() => {
      this.notice = "OpenCode accounts could not be read. Last known results are shown."
    }).finally(() => {
      this.refreshedAt = Date.now()
      this.refreshing = undefined
    })
    return this.refreshing
  }
  private async loadAccounts() {
    const { data } = await this.ctx.integration.get({ integrationID: "openai" })
    const active = await this.ctx.integration.connection.active("openai")
    const previous = new Map(this.accounts.map(a => [a.id, a]))
    const identities: Identity[] = []
    this.accounts = await Promise.all(data.connections.filter(c => c.type === "credential").map(async connection => {
      if (connection.type !== "credential") throw new Error("Unexpected connection")
      const account: Account = {
        id: connection.id, label: connection.label,
        active: active?.type === "credential" && active.id === connection.id,
        connected: true, status: "ok", error: null,
        quota: previous.get(connection.id)?.quota ?? null, totals: emptyTotals(),
      }
      if (connection.method !== "oauth") {
        account.status = "unsupported"
        account.error = "Subscription limits are available for ChatGPT sign-ins, not API keys."
      }
      try {
        // OpenCode owns token refresh and storage, including for inactive accounts.
        const credential = await this.ctx.integration.connection.resolve(connection)
        if (!credential) throw new Error("Account credential unavailable.")
        if (credential.type === "key") {
          identities.push({ id: account.id, label: account.label, fingerprint: hash(credential.key) })
          return account
        }
        if (credential.type !== "oauth") return account
        const metadata = object(credential.metadata)
        const accountID = typeof metadata.accountID === "string" ? metadata.accountID : tokenAccountID(credential.access)
        identities.push({ id: account.id, label: account.label, accountID, fingerprint: hash(credential.access) })
        if (credential.methodID === "chatgpt-token-sharing") {
          account.status = "unsupported"
          account.quota = null
          account.error = "This ChatGPT sign-in supports token tracking, but does not expose Codex allowances. View plan limits in ChatGPT Settings → Usage."
          return account
        }
        // Secrets are used only for this request; they are never stored by the plugin.
        try {
          account.quota = await fetchQuota(credential.access, accountID, this.controller.signal)
        } catch (error) {
          account.status = "error"
          account.error = error instanceof Error && /^(Sign in|This sign-in|Usage service|The usage service)/.test(error.message)
            ? error.message : "Could not reach the usage service. Last successful limits are shown if available."
        }
      } catch {
        account.status = "error"
        account.error = "OpenCode could not resolve this sign-in. Reconnect it in Settings → Providers."
      }
      return account
    }))
    this.identities = identities
  }
  private async identify(headers: Headers, event: RequestContext): Promise<Attribution | undefined> {
    const access = headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? headers.get("api-key")
    if (!access) return
    const accountID = headers.get("chatgpt-account-id") ?? tokenAccountID(access)
    const fingerprint = hash(access)
    const find = () => {
      const exact = this.identities.filter(i => i.fingerprint === fingerprint && (!accountID || !i.accountID || i.accountID === accountID))
      if (exact.length === 1) return exact[0]
      const byAccount = accountID ? this.identities.filter(i => i.accountID === accountID) : []
      return byAccount.length === 1 ? byAccount[0] : undefined
    }
    let identity = find()
    if (!identity && Date.now() - this.identityLookupAt > 5_000) {
      this.identityLookupAt = Date.now()
      await this.refresh(true)
      identity = find()
    }
    if (!identity) {
      this.notice = "Some requests could not be matched to a saved account and were omitted. Totals may be incomplete."
      return
    }
    return {
      accountID: identity.id, accountLabel: identity.label,
      model: event.model.id, sessionID: event.sessionID, source: event.kind,
    }
  }
  async snapshot(range: Range): Promise<Snapshot> {
    await this.refresh()
    // Selection is cheap local state, not quota data: never cache it with provider polls.
    const active = await this.ctx.integration.connection.active("openai")
    const now = Date.now()
    const records = await this.ledger.records(range, now)
    const accounts = this.accounts.map(a => ({
      ...a,
      active: active?.type === "credential" && active.id === a.id,
      totals: sum(records.filter(r => r.accountID === a.id)),
    }))
    for (const record of records) {
      if (accounts.some(a => a.id === record.accountID)) continue
      accounts.push({
        id: record.accountID, label: record.accountLabel, active: false, connected: false,
        status: "unsupported", error: "Account is no longer connected. Recorded usage is retained.",
        quota: null, totals: sum(records.filter(r => r.accountID === record.accountID)),
      })
    }
    const days = new Map<string, number>()
    const models = new Map<string, { model: string; total: number; requests: number }>()
    for (const record of records) {
      const total = record.input + record.output
      const day = new Date(record.at).toISOString().slice(0, 10)
      days.set(day, (days.get(day) ?? 0) + total)
      const model = models.get(record.model) ?? { model: record.model, total: 0, requests: 0 }
      model.total += total
      model.requests++
      models.set(record.model, model)
    }
    return {
      generatedAt: now, trackingSince: await this.ledger.since(), range,
      accounts, totals: sum(records),
      days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, total]) => ({ day, total })),
      models: [...models.values()].sort((a, b) => b.total - a.total),
      recent: records.slice(0, 50), notice: this.notice,
    }
  }
  async export(range: Range) {
    return { filename: `openai-usage-${range}-${new Date().toISOString().slice(0, 10)}.csv`, csv: csv(await this.ledger.records(range)) }
  }
}
