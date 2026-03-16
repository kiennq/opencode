import z from "zod"
import { Log } from "../../util/log"
import { iife } from "../../util/iife"
import { planTypeSchema } from "../types"
import type { CreditsSnapshot, PlanType, RateLimitWindow, UsageFetchResult } from "../types"

const log = Log.create({ service: "usage.openai" })

const endpoint = "https://chatgpt.com/backend-api/wham/usage"

type ChatgptUsageResponseWindow = {
  used_percent: number
  limit_window_seconds: number
  reset_after_seconds: number
  reset_at: number
}

type ChatgptUsageResponse = {
  plan_type: string | null
  rate_limit: {
    allowed: boolean
    limit_reached: boolean
    primary_window: ChatgptUsageResponseWindow | null
    secondary_window: ChatgptUsageResponseWindow | null
  }
  credits: {
    has_credits: boolean
    unlimited: boolean
    balance: string | null
  } | null
}

const windowSchema = z.object({
  used_percent: z.number(),
  limit_window_seconds: z.number(),
  reset_after_seconds: z.number(),
  reset_at: z.number(),
})

const responseSchema = z.object({
  plan_type: z.string().nullable(),
  rate_limit: z.object({
    allowed: z.boolean(),
    limit_reached: z.boolean(),
    primary_window: windowSchema.nullable(),
    secondary_window: windowSchema.nullable(),
  }),
  credits: z
    .object({
      has_credits: z.boolean(),
      unlimited: z.boolean(),
      balance: z.string().nullable(),
    })
    .nullable(),
}) satisfies z.ZodType<ChatgptUsageResponse>

export async function fetchChatgptUsage(accessToken: string, accountId?: string): Promise<UsageFetchResult> {
  const headers = iife(() => {
    const base = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    }
    if (!accountId) return base
    return { ...base, "ChatGPT-Account-Id": accountId }
  })

  const response = await fetch(endpoint, {
    headers,
    signal: AbortSignal.timeout(10_000),
  }).catch((error) => {
    log.warn("usage fetch failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  })

  if (!response) {
    return {
      snapshot: null,
      error: fetchError("OpenAI ChatGPT", "network"),
    }
  }

  if (!response.ok) {
    log.warn("usage fetch failed", { status: response.status })
    return {
      snapshot: null,
      error: fetchError("OpenAI ChatGPT", String(response.status)),
    }
  }

  const body = await response.json().catch(() => null)
  if (!body) {
    return {
      snapshot: null,
      error: fetchError("OpenAI ChatGPT", "empty response"),
    }
  }

  const parsed = responseSchema.safeParse(body)
  if (!parsed.success) {
    log.warn("usage fetch parse failed", { issues: parsed.error.issues.length })
    return {
      snapshot: null,
      error: fetchError("OpenAI ChatGPT", "parse failed"),
    }
  }

  const rateLimit = parsed.data.rate_limit
  const primary = toWindow(rateLimit.primary_window)
  const secondary = toWindow(rateLimit.secondary_window)
  const credits = toCredits(parsed.data.credits)
  const planType = toPlanType(parsed.data.plan_type)

  return {
    snapshot: {
      primary,
      secondary,
      tertiary: null,
      credits,
      planType,
      updatedAt: Date.now(),
    },
  }
}

function fetchError(provider: string, detail: string | null): string {
  if (!detail) return `${provider} usage request failed`
  return `${provider} usage request failed (${detail})`
}

function toWindow(window: ChatgptUsageResponseWindow | null): RateLimitWindow | null {
  if (!window) return null
  return {
    usedPercent: window.used_percent,
    windowMinutes: Math.round(window.limit_window_seconds / 60),
    resetsAt: window.reset_at,
  }
}

function toCredits(credits: ChatgptUsageResponse["credits"]): CreditsSnapshot | null {
  if (!credits) return null
  return {
    hasCredits: credits.has_credits,
    unlimited: credits.unlimited,
    balance: credits.balance,
  }
}

function toPlanType(value: ChatgptUsageResponse["plan_type"]): PlanType | null {
  if (!value) return null
  const parsed = planTypeSchema.safeParse(value)
  if (!parsed.success) return null
  return parsed.data
}
