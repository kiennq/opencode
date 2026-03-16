import z from "zod"

export const planTypeSchema = z.enum([
  "guest",
  "free",
  "go",
  "plus",
  "pro",
  "free_workspace",
  "team",
  "business",
  "education",
  "quorum",
  "k12",
  "enterprise",
  "edu",
])
export type PlanType = z.infer<typeof planTypeSchema>

export const rateLimitWindowSchema = z.object({
  usedPercent: z.number(),
  windowMinutes: z.number().nullable(),
  resetsAt: z.number().nullable(),
})
export type RateLimitWindow = z.infer<typeof rateLimitWindowSchema>

export const creditsSnapshotSchema = z.object({
  hasCredits: z.boolean(),
  unlimited: z.boolean(),
  balance: z.string().nullable(),
  total: z.number().nullable().optional(),
  used: z.number().nullable().optional(),
  remaining: z.number().nullable().optional(),
})
export type CreditsSnapshot = z.infer<typeof creditsSnapshotSchema>

export const snapshotSchema = z.object({
  primary: rateLimitWindowSchema.nullable(),
  secondary: rateLimitWindowSchema.nullable(),
  tertiary: rateLimitWindowSchema.nullable(),
  credits: creditsSnapshotSchema.nullable(),
  planType: planTypeSchema.nullable(),
  updatedAt: z.number(),
})
export type Snapshot = z.infer<typeof snapshotSchema>

export type UsageFetchResult = {
  snapshot: Snapshot | null
  error?: string
}
