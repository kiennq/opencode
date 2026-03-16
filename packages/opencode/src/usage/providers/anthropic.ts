import z from "zod"
import { Auth } from "../../auth"
import { iife } from "../../util/iife"
import { Log } from "../../util/log"
import type { CreditsSnapshot, RateLimitWindow, UsageFetchResult } from "../types"

const log = Log.create({ service: "usage.anthropic" })

const usageEndpoint = "https://api.anthropic.com/api/oauth/usage"
const tokenEndpoint = "https://console.anthropic.com/v1/oauth/token"
const clientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

type ClaudeUsageWindow = {
  utilization: number
  resets_at: string | null
}

type ClaudeUsageResponse = {
  five_hour?: ClaudeUsageWindow | null
  seven_day?: ClaudeUsageWindow | null
  extra_usage?: {
    is_enabled?: boolean | null
    monthly_limit?: number | null
    used_credits?: number | null
    utilization?: number | null
  } | null
}

type ClaudeAuth = Extract<Auth.Info, { type: "oauth" }>

type ClaudeTokenResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
}

type ClaudeErrorResponse = {
  error?: {
    message?: string
    details?: {
      error_code?: string
    }
  }
}

const windowSchema = z.object({
  utilization: z.number(),
  resets_at: z.string().nullable(),
})

const responseSchema = z.object({
  five_hour: windowSchema.nullish(),
  seven_day: windowSchema.nullish(),
  extra_usage: z
    .object({
      is_enabled: z.boolean().nullish(),
      monthly_limit: z.number().nullish(),
      used_credits: z.number().nullish(),
      utilization: z.number().nullish(),
    })
    .nullish(),
}) satisfies z.ZodType<ClaudeUsageResponse>

export async function fetchClaudeUsage(authKey: string, auth: ClaudeAuth): Promise<UsageFetchResult> {
  return fetchClaudeUsageInternal(authKey, auth, false)
}

async function fetchClaudeUsageInternal(
  authKey: string,
  auth: ClaudeAuth,
  refreshed: boolean,
): Promise<UsageFetchResult> {
  const currentAuth = await iife(async () => {
    if (auth.expires > 0 && Date.now() >= auth.expires) {
      return refreshAuth(authKey, auth)
    }
    return auth
  })

  if (!currentAuth) {
    return {
      snapshot: null,
      error: fetchError("Claude", "token expired"),
    }
  }

  const response = await requestUsage(currentAuth.access)
  if (!response) {
    return {
      snapshot: null,
      error: fetchError("Claude", "network"),
    }
  }

  if (response.status === 401) {
    const body = (await response.json().catch(() => null)) as ClaudeErrorResponse | null
    if (isTokenExpired(body) && !refreshed) {
      const nextAuth = await refreshAuth(authKey, currentAuth)
      if (!nextAuth) {
        return {
          snapshot: null,
          error: fetchError("Claude", String(response.status)),
        }
      }
      return fetchClaudeUsageInternal(authKey, nextAuth, true)
    }

    log.warn("claude usage fetch failed", { status: response.status })
    return {
      snapshot: null,
      error: fetchError("Claude", String(response.status)),
    }
  }

  if (!response.ok) {
    log.warn("claude usage fetch failed", { status: response.status })
    return {
      snapshot: null,
      error: fetchError("Claude", String(response.status)),
    }
  }

  const body = await response.json().catch(() => null)
  if (!body) {
    return {
      snapshot: null,
      error: fetchError("Claude", "empty response"),
    }
  }

  const parsed = responseSchema.safeParse(body)
  if (!parsed.success) {
    log.warn("claude usage parse failed", { issues: parsed.error.issues.length })
    return {
      snapshot: null,
      error: fetchError("Claude", "parse failed"),
    }
  }

  const data = parsed.data
  const primary = toWindow(data.five_hour, 5 * 60)
  const secondary = toWindow(data.seven_day, 7 * 24 * 60)
  const credits = toCredits(data.extra_usage)

  return {
    snapshot: {
      primary,
      secondary,
      tertiary: null,
      credits,
      planType: null,
      updatedAt: Date.now(),
    },
  }
}

async function requestUsage(accessToken: string): Promise<Response | null> {
  return fetch(usageEndpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  }).catch((error) => {
    log.warn("claude usage fetch failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  })
}

function isTokenExpired(body: ClaudeErrorResponse | null): boolean {
  if (!body || typeof body !== "object") return false
  const error = body.error
  if (!error) return false
  const code = error.details?.error_code
  if (code === "token_expired") return true
  if (error.message?.toLowerCase().includes("expired")) return true
  return false
}

async function refreshAuth(authKey: string, auth: ClaudeAuth): Promise<ClaudeAuth | null> {
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: auth.refresh,
      client_id: clientId,
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch((error) => {
    log.warn("claude token refresh failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  })

  if (!response) return null
  if (!response.ok) {
    log.warn("claude token refresh failed", { status: response.status })
    return null
  }

  const body = (await response.json().catch(() => null)) as ClaudeTokenResponse | null
  if (!body) return null

  const access = typeof body.access_token === "string" ? body.access_token : null
  if (!access) return null

  const refresh = typeof body.refresh_token === "string" ? body.refresh_token : auth.refresh
  const expires = typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : auth.expires
  const next: Auth.Info = {
    type: "oauth",
    refresh,
    access,
    expires,
    ...(auth.accountId ? { accountId: auth.accountId } : {}),
    ...(auth.enterpriseUrl ? { enterpriseUrl: auth.enterpriseUrl } : {}),
    ...(auth.usage ? { usage: auth.usage } : {}),
  }

  await Auth.set(authKey, next)
  return next
}

function fetchError(provider: string, detail: string | null): string {
  if (!detail) return `${provider} usage request failed`
  return `${provider} usage request failed (${detail})`
}

function toWindow(window: ClaudeUsageWindow | null | undefined, windowMinutes: number | null): RateLimitWindow | null {
  if (!window) return null

  const resetsAt = iife(() => {
    if (!window.resets_at) return null
    const ms = new Date(window.resets_at).getTime()
    if (Number.isNaN(ms)) return null
    return Math.floor(ms / 1000)
  })

  return {
    usedPercent: window.utilization,
    windowMinutes,
    resetsAt,
  }
}

function toCredits(extra: ClaudeUsageResponse["extra_usage"]): CreditsSnapshot | null {
  if (!extra) return null
  if (extra.is_enabled === false) return null

  const limit = typeof extra.monthly_limit === "number" ? extra.monthly_limit : null
  const used = typeof extra.used_credits === "number" ? extra.used_credits : null
  if (limit !== null && used !== null) {
    const remaining = Math.max(0, Math.round((limit - used) * 100) / 100)
    return {
      hasCredits: remaining > 0,
      unlimited: false,
      balance: String(remaining),
    }
  }

  const utilization = typeof extra.utilization === "number" ? extra.utilization : null
  if (utilization !== null) {
    return {
      hasCredits: utilization < 100,
      unlimited: false,
      balance: null,
    }
  }

  return null
}
