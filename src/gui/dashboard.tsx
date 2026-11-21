import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { Account, Range, Snapshot, UsageWindow } from "../schema"
import { allowanceWindows, quotaIsStale, selectedAccount } from "./selected-account"
import styles from "./dashboard.css?inline"

const number = (n: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n)
const exact = (n: number) => n.toLocaleString()
const dateTime = (n: number) => new Date(n).toLocaleString()
function until(at: number | null, now: number) {
  if (at === null) return "Reset time unavailable"
  const minutes = Math.ceil((at - now) / 60000)
  if (minutes <= 0) return "Reset due · refresh to confirm"
  if (minutes < 60) return `Resets in ${minutes}m`
  if (minutes < 1440) return `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `Resets in ${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`
}
function Meter(props: { window: UsageWindow; now: number; stale: boolean }) {
  const remaining = () => props.window.usedPercent === null ? null : 100 - props.window.usedPercent
  const tone = () => remaining() === null ? "" : remaining()! <= 10 ? "danger" : remaining()! <= 25 ? "warning" : ""
  return <div class={`au-meter ${tone()}`}>
    <div class="au-row"><span>{props.window.label}</span><strong>{remaining() === null ? "Unknown" : `${Number(remaining()!.toFixed(1))}% left`}</strong></div>
    <div class="au-track" role="meter" aria-label={`${props.window.label} remaining`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining() ?? undefined}>
      <div style={{ width: `${remaining() ?? 0}%` }} />
    </div>
    <div class="au-row au-muted au-small"><span title={props.window.resetsAt ? dateTime(props.window.resetsAt) : undefined}>{until(props.window.resetsAt, props.now)}</span><span>{props.stale ? "Last known" : "Provider reported"}</span></div>
  </div>
}
function AccountCard(props: { account: Account; now: number; index: number }) {
  const a = () => props.account
  const stale = () => a().status !== "ok" || !a().quota || props.now - a().quota!.checkedAt > 120000
  return <article class="au-account" style={{ "--account-color": props.index % 2 ? "#a79af4" : "#6fd9b4" }}>
    <div class="au-row au-account-head">
      <div class="au-identity"><div class="au-avatar">{a().label.replace(/^OpenAI\s*/i, "").slice(0, 2).toUpperCase()}</div><div><h3>{a().label}</h3><span class="au-muted au-small">{a().quota?.plan ? `${a().quota!.plan!.toUpperCase()} PLAN` : a().connected ? "CONNECTED ACCOUNT" : "DISCONNECTED"}</span></div></div>
      <Show when={a().active}><span class="au-badge">Selected</span></Show>
    </div>
    <Show when={a().quota?.allowed === false}><div class="au-alert">Codex limit reached</div></Show>
    <Show when={a().error}><p class="au-account-error">{a().error}</p></Show>
    <For each={a().quota?.windows}>{window => <Meter window={window} now={props.now} stale={stale()} />}</For>
    <Show when={!a().quota?.windows.length}><div class="au-no-quota">No allowance data available</div></Show>
    <Show when={a().quota?.credits !== null && a().quota?.credits !== undefined}>
      <div class="au-row au-muted au-small au-credits"><span>Additional credits</span><strong>{a().quota?.unlimitedCredits ? "Unlimited" : a().quota?.credits}</strong></div>
    </Show>
    <div class="au-account-stats">
      <div><strong title={exact(a().totals.total)}>{number(a().totals.total)}</strong><span>tokens tracked</span></div>
      <div><strong>{number(a().totals.requests)}</strong><span>requests</span></div>
      <div><strong>{a().totals.input ? Math.round(a().totals.cached / a().totals.input * 100) : 0}%</strong><span>input cached</span></div>
    </div>
    <Show when={a().quota}><div class="au-small au-muted au-last">Limits checked {dateTime(a().quota!.checkedAt)}{stale() ? " · stale" : ""}</div></Show>
  </article>
}

function SelectedAllowance(props: { account: Account; now: number; offline: boolean }) {
  const account = () => props.account
  const windows = () => allowanceWindows(account())
  const stale = () => props.offline || quotaIsStale(account(), props.now)
  return <section class="au-selected" aria-label="Selected OpenAI account usage remaining">
    <div class="au-row au-selected-head">
      <div><h2>Usage remaining</h2><div class="au-selected-name">{account().label}</div></div>
      <span class="au-badge">Selected OpenAI account</span>
    </div>
    <Show when={account().quota?.allowed === false}><div class="au-alert">Codex limit reached</div></Show>
    <Show when={account().error}><p class="au-account-error">{account().error}</p></Show>
    <Show when={windows().length} fallback={<p class="au-muted au-small">Remaining allowance unavailable for this account.</p>}>
      <div class="au-selected-meters"><For each={windows()}>{window =>
        <Meter window={window} now={props.now} stale={stale()} />
      }</For></div>
      <Show when={stale()}><p class="au-small au-muted">Last known allowance · checked {account().quota ? dateTime(account().quota!.checkedAt) : "unknown"}</p></Show>
    </Show>
  </section>
}

export function Dashboard(props: {
  load: (range: Range) => Promise<Snapshot>
  exportData: (range: Range) => Promise<{ filename: string; csv: string }>
  openUsage: () => void
  watchAccounts?: (onChange: () => void) => () => void
}) {
  const [range, setRange] = createSignal<Range>("week")
  const [snapshot, setSnapshot] = createSignal<Snapshot>()
  const [busy, setBusy] = createSignal(false)
  const [exporting, setExporting] = createSignal(false)
  const [error, setError] = createSignal("")
  const [now, setNow] = createSignal(Date.now())
  const [filter, setFilter] = createSignal("all")
  let generation = 0
  let disposed = false
  async function refresh() {
    const request = ++generation
    const selected = range()
    setBusy(true)
    try {
      const result = await props.load(selected)
      if (disposed || request !== generation) return
      setSnapshot(result)
      setError("")
    } catch {
      if (!disposed && request === generation) setError("Could not connect to the usage plugin. Check Settings → Extensions and try again.")
    } finally {
      if (!disposed && request === generation) setBusy(false)
    }
  }
  createEffect(() => { range(); void refresh() })
  createEffect(() => {
    const unsubscribe = props.watchAccounts?.(() => { void refresh() })
    if (unsubscribe) onCleanup(unsubscribe)
  })
  const tick = setInterval(() => setNow(Date.now()), 30000)
  const poll = setInterval(() => { if (!busy()) void refresh() }, 60000)
  onCleanup(() => { disposed = true; clearInterval(tick); clearInterval(poll) })
  const days = createMemo(() => {
    const data = snapshot()
    if (!data) return []
    const amount = data.range === "day" ? 2 : data.range === "week" ? 8 : data.range === "month" ? 31 : 30
    const lookup = new Map(data.days.map(d => [d.day, d.total]))
    return Array.from({ length: amount }, (_, i) => {
      const date = new Date(data.generatedAt)
      date.setUTCDate(date.getUTCDate() - (amount - 1 - i))
      const day = date.toISOString().slice(0, 10)
      return { day, total: lookup.get(day) ?? 0 }
    })
  })
  const peak = () => Math.max(1, ...days().map(d => d.total))
  const selected = createMemo(() => selectedAccount(snapshot()?.accounts ?? []))
  const recent = () => snapshot()?.recent.filter(r => filter() === "all" || r.accountID === filter()) ?? []
  async function download() {
    setExporting(true)
    try {
      const result = await props.exportData(range())
      if (disposed) return
      const url = URL.createObjectURL(new Blob(["\uFEFF", result.csv], { type: "text/csv;charset=utf-8" }))
      const anchor = document.createElement("a")
      anchor.href = url; anchor.download = result.filename
      document.body.append(anchor); anchor.click(); anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch { if (!disposed) setError("The usage export failed. Please try again.") }
    finally { if (!disposed) setExporting(false) }
  }
  return <div class="au-root" id="overview">
    <style>{styles}</style>
    <header class="au-header">
      <div><h1>OpenAI usage</h1><p class="au-muted">Codex allowances and OpenCode token activity.</p></div>
      <button class="au-button au-refresh" onClick={() => void refresh()} disabled={busy()} aria-label="Refresh account usage">{busy() ? "Syncing…" : "↻ Refresh"}</button>
    </header>
    <Show when={selected()} fallback={
      <div class="au-selected au-muted" role="status">{snapshot() ? "No saved OpenAI account selected." : error() ? "Selected account unavailable. Refresh to try again." : "Loading selected OpenAI account…"}</div>
    }>{account => <SelectedAllowance account={account()} now={now()} offline={!!error()} />}</Show>
    <div class="au-toolbar"><div class="au-ranges" aria-label="Token activity period">
      <For each={[["day", "24 hours"], ["week", "7 days"], ["month", "30 days"], ["all", "All time"]] as const}>{([value, label]) =>
        <button aria-pressed={range() === value} classList={{ selected: range() === value }} onClick={() => setRange(value)}>{label}</button>
      }</For>
    </div><button class="au-button" onClick={() => void download()} disabled={exporting() || !snapshot()}>{exporting() ? "Exporting…" : "Export CSV ↗"}</button></div>
    <Show when={error()}><div class="au-alert" role="alert">{error()}</div></Show>
    <Show when={!snapshot() && busy()}><div class="au-empty" role="status">Reading your connected accounts…</div></Show>
    <Show when={snapshot()}>{data => <>
      <Show when={data().notice}><div class="au-alert">{data().notice}</div></Show>
      <div class="au-summary">
        <div><span>Total tokens</span><strong title={exact(data().totals.total)}>{number(data().totals.total)}</strong><small>{number(data().totals.requests)} recorded requests</small></div>
        <div><span>Input</span><strong title={exact(data().totals.input)}>{number(data().totals.input)}</strong><small>{number(data().totals.cached)} cached</small></div>
        <div><span>Output</span><strong title={exact(data().totals.output)}>{number(data().totals.output)}</strong><small>{number(data().totals.reasoning)} reasoning</small></div>
      </div>
      <div class="au-section-title"><h2>Connected accounts <span>{data().accounts.filter(a => a.connected).length}</span></h2><button class="au-button" onClick={props.openUsage}>ChatGPT usage ↗</button></div>
      <p class="au-small au-muted" style={{ "margin-bottom": "14px" }}>Allowances are current, independent of the selected period. The ChatGPT link uses your browser’s signed-in account.</p>
      <Show when={data().accounts.length} fallback={<div class="au-empty">Connect an OpenAI account in Settings → Providers to see it here.</div>}>
        <div class="au-accounts"><For each={data().accounts}>{(account, i) => <AccountCard account={account} now={now()} index={i()} />}</For></div>
      </Show>
      <section class="au-section">
        <div class="au-section-title"><h2>Token activity</h2><span class="au-small au-muted">{data().range === "all" ? "Last 30 days · UTC" : "Daily totals · UTC"}</span></div>
        <div class="au-chart" role="img" aria-label={`Daily token activity: ${days().map(d => `${d.day}: ${d.total}`).join(", ")}`}>
          <For each={days()}>{day => <div class="au-bar-column" title={`${day.day}: ${exact(day.total)} tokens`}><div class="au-bar" classList={{ zero: day.total === 0 }} style={{ height: `${Math.max(2, day.total / peak() * 100)}%` }} /></div>}</For>
        </div>
        <div class="au-row au-muted au-small"><span>{days()[0]?.day}</span><span>{data().totals.total === 0 ? "Activity appears as you use OpenCode" : "Input + output; cached and reasoning tokens included"}</span><span>{days().at(-1)?.day}</span></div>
      </section>
      <Show when={data().models.length}><section class="au-section">
        <div class="au-section-title"><h2>By model</h2></div>
        <For each={data().models}>{model => <div class="au-model"><span>{model.model}</span><span class="au-muted">{number(model.requests)} requests</span><strong title={exact(model.total)}>{number(model.total)}</strong></div>}</For>
      </section></Show>
      <section class="au-section">
        <div class="au-section-title"><h2>Recent requests</h2><select aria-label="Filter recent requests by account" value={filter()} onChange={event => setFilter(event.currentTarget.value)}><option value="all">All accounts</option><For each={data().accounts}>{a => <option value={a.id}>{a.label}</option>}</For></select></div>
        <Show when={recent().length} fallback={<div class="au-empty">No recorded requests in this period yet.</div>}>
          <div class="au-table-wrap"><table><thead><tr><th>Account / model</th><th>Input</th><th>Output</th><th>When</th></tr></thead><tbody>
            <For each={recent()}>{record => <tr><td><strong>{record.accountLabel}</strong><small>{record.model} · {record.source}</small></td><td title={exact(record.input)}>{number(record.input)}</td><td title={exact(record.output)}>{number(record.output)}</td><td title={dateTime(record.at)}>{new Date(record.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}<small>{new Date(record.at).toLocaleDateString()}</small></td></tr>}</For>
          </tbody></table></div>
        </Show>
        <p class="au-muted au-small">Showing up to 50 recent requests. CSV includes all recorded requests in the selected period.</p>
      </section>
      <footer class="au-footer"><span class="au-dot" /><div>Tracking since {dateTime(data().trackingSince)}<p>Token counts cover observed OpenCode Responses requests since installation. Codex limits are account-wide, including usage elsewhere. ChatGPT website token history and subscription charges are not exposed here. Cached input and reasoning are included in totals, not added twice.</p><span>Automatic refresh every minute · Last sync {dateTime(data().generatedAt)}</span></div></footer>
    </>}</Show>
  </div>
}
