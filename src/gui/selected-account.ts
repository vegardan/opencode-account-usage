import type { Account } from "../schema"

export function selectedAccount(accounts: Account[]): Account | undefined {
  return accounts.find(account => account.active && account.connected)
}

export function allowanceWindows(account: Account) {
  // Keep simultaneous limits separate: combining them into one percentage is misleading.
  // Code-review and model-specific allowances remain in the detailed account cards.
  return account.quota?.windows.filter(window => window.id.startsWith("codex/")) ?? []
}

export function quotaIsStale(account: Account, now: number) {
  return account.status !== "ok" || !account.quota || now - account.quota.checkedAt > 120_000
}

export function usageButton(account: Account | undefined, now: number, offline = false) {
  if (!account) return { label: "OpenAI usage", title: "OpenAI account usage · no selected account data" }
  const name = account.label.trim() || "OpenAI"
  const windows = allowanceWindows(account)
  const known = windows.filter(window => window.usedPercent !== null)
  if (!known.length) return {
    label: `${name} · usage unavailable`,
    title: `${account.label} · ${account.error ?? "Remaining allowance unavailable"}`,
  }
  // Either cap can stop requests, so the compact label shows the lowest headroom.
  const remaining = account.quota?.allowed === false ? 0 : Math.min(...known.map(window => 100 - window.usedPercent!))
  const stale = offline || quotaIsStale(account, now)
  return {
    label: `${name} · ${Number(remaining.toFixed(1))}% left${stale ? " · stale" : ""}`,
    title: [
      account.label,
      ...windows.map(window => `${window.label}: ${window.usedPercent === null ? "unknown" : `${Number((100 - window.usedPercent).toFixed(1))}% left`}`),
      account.quota?.allowed === false ? "Codex limit reached" : "Shows the lowest remaining Codex allowance",
      stale ? "Last known reading · refresh unavailable or data is stale" : "Updates automatically every minute",
    ].join("\n"),
  }
}
