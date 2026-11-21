import { render } from "solid-js/web"
import { Dashboard } from "../src/gui/dashboard"
import type { Snapshot } from "../src/schema"

const now = Date.now()
const empty = { requests: 0, input: 0, cached: 0, output: 0, reasoning: 0, total: 0 }
const totals = { requests: 8, input: 280000, cached: 224000, output: 28000, reasoning: 14000, total: 308000 }
const sample: Snapshot = {
  generatedAt: now, trackingSince: now - 3600000, range: "week",
  accounts: [
    { id: "demo-a", label: "OpenAI Personal", active: true, connected: true, status: "ok", error: null, totals,
      quota: { checkedAt: now, plan: "plus", allowed: true, credits: "0", unlimitedCredits: false, windows: [
        { id: "codex/primary_window", label: "Codex · 5-hour", usedPercent: 36, resetsAt: now + 7200000, seconds: 18000 },
        { id: "codex/secondary_window", label: "Codex · 7-day", usedPercent: 81, resetsAt: now + 172800000, seconds: 604800 },
      ] } },
    { id: "demo-b", label: "OpenAI Work", active: false, connected: true, status: "unsupported",
      error: "This ChatGPT sign-in supports token tracking, but does not expose Codex allowances. View plan limits in ChatGPT Settings → Usage.",
      quota: null, totals: empty },
  ],
  totals, days: [{ day: new Date(now).toISOString().slice(0, 10), total: totals.total }],
  models: [{ model: "gpt-example", requests: 8, total: totals.total }],
  recent: Array.from({ length: 8 }, (_, i) => ({
    id: `demo-${i}`, accountID: "demo-a", accountLabel: "OpenAI Personal", at: now - i * 60000,
    model: "gpt-example", source: "primary", sessionID: "demo", input: 35000, cached: 28000, output: 3500, reasoning: 1750,
  })), notice: null,
}
render(() => <>
  <div style={{ background: "#3f3423", color: "#f2d4a3", padding: "8px 20px", "font-family": "system-ui", "font-size": "12px" }}>Development preview — sample data, no account connection</div>
  <main style={{ "max-width": "1080px", margin: "auto" }}>
    <Dashboard load={async range => ({ ...sample, range })} exportData={async () => ({ filename: "sample.csv", csv: "Sample data only\r\n" })} openUsage={() => window.open("https://chatgpt.com/settings/usage", "_blank", "noopener,noreferrer")} />
  </main>
</>, document.getElementById("app")!)
