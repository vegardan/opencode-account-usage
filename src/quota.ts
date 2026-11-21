import type { Quota, UsageWindow } from "./schema"

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}
function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}
export function durationLabel(seconds: number | null): string {
  if (!seconds) return "Window"
  if (seconds % 86400 === 0) return `${seconds / 86400}-day`
  if (seconds % 3600 === 0) return `${seconds / 3600}-hour`
  return `${Math.round(seconds / 60)}-minute`
}
export function parseQuota(payload: unknown, now = Date.now()): Quota {
  const body = object(payload)
  if (!("rate_limit" in body || "additional_rate_limits" in body || "credits" in body)) {
    throw new Error("Unrecognized usage response")
  }
  const windows: UsageWindow[] = []
  const append = (value: unknown, id: string, title: string) => {
    const limits = object(value)
    for (const slot of ["primary_window", "secondary_window"]) {
      const w = object(limits[slot])
      if (Object.keys(w).length === 0) continue
      const used = finite(w.used_percent)
      const seconds = finite(w.limit_window_seconds)
      const reset = finite(w.reset_at)
      const after = finite(w.reset_after_seconds)
      windows.push({
        id: `${id}/${slot}`,
        label: `${title} · ${durationLabel(seconds)}`,
        usedPercent: used === null ? null : Math.max(0, Math.min(100, used)),
        seconds,
        resetsAt: reset !== null ? reset * 1000 : after !== null ? now + after * 1000 : null,
      })
    }
  }
  append(body.rate_limit, "codex", "Codex")
  append(body.code_review_rate_limit, "review", "Code review")
  if (Array.isArray(body.additional_rate_limits)) {
    body.additional_rate_limits.forEach((item, i) => {
      const extra = object(item)
      append(extra.rate_limit ?? extra, `extra-${i}`, String(extra.limit_name ?? extra.title ?? extra.id ?? "Additional"))
    })
  }
  const credits = object(body.credits)
  const limits = object(body.rate_limit)
  return {
    checkedAt: now,
    plan: typeof body.plan_type === "string" ? body.plan_type : null,
    allowed: limits.limit_reached === true ? false : typeof limits.allowed === "boolean" ? limits.allowed : null,
    windows,
    credits: typeof credits.balance === "string" || typeof credits.balance === "number" ? String(credits.balance) : null,
    unlimitedCredits: credits.unlimited === true,
  }
}

// Decode only an account identifier. Tokens and other claims never leave this function.
export function tokenAccountID(access: string): string | undefined {
  try {
    const claims = object(JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString()))
    const id = object(claims["https://api.openai.com/auth"]).chatgpt_account_id
    return typeof id === "string" ? id : undefined
  } catch { return undefined }
}

export async function fetchQuota(access: string, accountID: string | undefined, signal: AbortSignal): Promise<Quota> {
  const headers = new Headers({ Authorization: `Bearer ${access}`, Accept: "application/json" })
  if (accountID) headers.set("ChatGPT-Account-Id", accountID)
  const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), redirect: "error",
  })
  if (!response.ok) {
    // Never surface raw error bodies or headers: either can contain credential information.
    await response.body?.cancel()
    if (response.status === 401) throw new Error("Sign in to this account again in Settings → Providers.")
    if (response.status === 403) throw new Error("This sign-in cannot access Codex limits (HTTP 403).")
    if (response.status === 429) throw new Error("Usage service rate limited the request. Try again later.")
    throw new Error(`Usage service returned HTTP ${response.status}.`)
  }
  try { return parseQuota(await response.json()) }
  catch { throw new Error("The usage service returned an unsupported response.") }
}
