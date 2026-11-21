import { z } from "zod"

export const WindowSchema = z.object({
  id: z.string(),
  label: z.string(),
  usedPercent: z.number().nullable(),
  resetsAt: z.number().nullable(),
  seconds: z.number().nullable(),
})
export const QuotaSchema = z.object({
  checkedAt: z.number(),
  plan: z.string().nullable(),
  allowed: z.boolean().nullable(),
  windows: z.array(WindowSchema),
  credits: z.string().nullable(),
  unlimitedCredits: z.boolean(),
})
export const TotalsSchema = z.object({
  requests: z.number(),
  input: z.number(),
  cached: z.number(),
  output: z.number(),
  reasoning: z.number(),
  total: z.number(),
})
export const RecordSchema = z.object({
  id: z.string(),
  accountID: z.string(),
  accountLabel: z.string(),
  at: z.number(),
  model: z.string(),
  source: z.string(),
  sessionID: z.string(),
  input: z.number(),
  cached: z.number(),
  output: z.number(),
  reasoning: z.number(),
})
export const AccountSchema = z.object({
  id: z.string(),
  label: z.string(),
  active: z.boolean(),
  connected: z.boolean(),
  status: z.enum(["ok", "error", "unsupported"]),
  error: z.string().nullable(),
  quota: QuotaSchema.nullable(),
  totals: TotalsSchema,
})
export const RangeSchema = z.enum(["day", "week", "month", "all"])
export const SnapshotSchema = z.object({
  generatedAt: z.number(),
  trackingSince: z.number(),
  range: RangeSchema,
  accounts: z.array(AccountSchema),
  totals: TotalsSchema,
  days: z.array(z.object({ day: z.string(), total: z.number() })),
  models: z.array(z.object({ model: z.string(), total: z.number(), requests: z.number() })),
  recent: z.array(RecordSchema),
  notice: z.string().nullable(),
})
export type UsageWindow = z.infer<typeof WindowSchema>
export type Quota = z.infer<typeof QuotaSchema>
export type Totals = z.infer<typeof TotalsSchema>
export type UsageRecord = z.infer<typeof RecordSchema>
export type Account = z.infer<typeof AccountSchema>
export type Range = z.infer<typeof RangeSchema>
export type Snapshot = z.infer<typeof SnapshotSchema>
