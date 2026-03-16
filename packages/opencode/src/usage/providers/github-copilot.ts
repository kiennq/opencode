import z from "zod"
import { iife } from "../../util/iife"
import { Log } from "../../util/log"
import type { PlanType, RateLimitWindow, Snapshot, UsageFetchResult } from "../types"

const log = Log.create({ service: "usage.github-copilot" })

const usageEndpoint = "https://api.github.com/copilot_internal/user"
const integrationID = "vscode-chat"

const skuPlan: Record<string, PlanType> = {
  free_limited_copilot: "free",
  copilot_for_individual: "pro",
  copilot_individual: "pro",
  copilot_business: "business",
  copilot_enterprise: "enterprise",
  copilot_for_business: "business",
}

const quotaSchema = z.object({
  entitlement: z.number(),
  remaining: z.number(),
  percent_remaining: z.number(),
  quota_id: z.string(),
})

const responseSchema = z.object({
  quota_snapshots: z.object({
    premium_interactions: quotaSchema.nullish(),
    chat: quotaSchema.nullish(),
  }),
  copilot_plan: z.string().optional(),
  assigned_date: z.string().optional(),
  quota_reset_date: z.string().optional(),
})

type CopilotTokenMetadata = {
  tid?: string
  exp?: number
  sku?: string
  proxyEndpoint?: string
  quotaLimit?: number
  resetDate?: number
}

type CopilotAuthInfo = {
  access: string
  refresh: string
  usage?: string
  enterpriseUrl?: string
}

export function parseCopilotAccessToken(accessToken: string): CopilotTokenMetadata {
  const result: CopilotTokenMetadata = {}
  const parts = accessToken.split(";")

  for (const part of parts) {
    const eqIndex = part.indexOf("=")
    if (eqIndex === -1) continue
    const key = part.slice(0, eqIndex)
    const value = part.slice(eqIndex + 1)

    switch (key) {
      case "tid":
        result.tid = value
        break
      case "exp":
        result.exp = Number.parseInt(value, 10)
        break
      case "sku":
        result.sku = value
        break
      case "proxy-ep":
        result.proxyEndpoint = value
        break
      case "cq":
        result.quotaLimit = Number.parseInt(value, 10)
        break
      case "rd": {
        const colon = value.indexOf(":")
        if (colon > 0) {
          result.resetDate = Number.parseInt(value.slice(0, colon), 10)
        }
        break
      }
    }
  }

  return result
}

export function copilotSkuToPlan(sku: string | undefined): PlanType | null {
  if (!sku) return null
  return skuPlan[sku] ?? fallbackPlan(sku)
}

export async function fetchCopilotUsage(auth: CopilotAuthInfo): Promise<UsageFetchResult> {
  const token = parseCopilotAccessToken(auth.access)
  const fallback = snapshotFromToken(token)

  const response = await fetch(resolveUsageUrl(auth.enterpriseUrl), {
    method: "GET",
    headers: {
      Authorization: `token ${auth.usage ?? auth.refresh}`,
      Accept: "application/json",
      "Copilot-Integration-Id": integrationID,
      "Editor-Version": "vscode/1.96.2",
      "Editor-Plugin-Version": "copilot-chat/0.26.7",
      "User-Agent": "GitHubCopilotChat/0.26.7",
      "X-Github-Api-Version": "2025-04-01",
    },
    signal: AbortSignal.timeout(10_000),
  }).catch((error) => {
    log.warn("copilot usage fetch failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  })

  if (!response) {
    return {
      snapshot: fallback,
      error: fetchError("Copilot", "network"),
    }
  }

  if (!response.ok) {
    log.warn("copilot usage fetch failed", { status: response.status })
    return {
      snapshot: fallback,
      error: fetchError("Copilot", String(response.status)),
    }
  }

  const body = await response.json().catch(() => null)
  if (!body) {
    return {
      snapshot: fallback,
      error: fetchError("Copilot", "empty response"),
    }
  }

  const parsed = responseSchema.safeParse(body)
  if (!parsed.success) {
    log.warn("copilot usage parse failed", { issues: parsed.error.issues.length })
    return {
      snapshot: fallback,
      error: fetchError("Copilot", "parse failed"),
    }
  }

  const data = parsed.data
  const premium = data.quota_snapshots.premium_interactions ?? null
  const chat = data.quota_snapshots.chat ?? null
  const resetAt = parseResetDate(data.quota_reset_date) ?? token.resetDate ?? null
  const planType = copilotSkuToPlan(data.copilot_plan) ?? copilotSkuToPlan(token.sku)
  const counts = iife(() => {
    if (!premium) return null
    const total = Math.max(0, Math.floor(premium.entitlement))
    const remaining = Math.max(0, Math.floor(premium.remaining))
    const used = Math.max(0, total - remaining)
    return {
      total,
      used,
      remaining,
    }
  })

  const primary: RateLimitWindow | null = iife(() => {
    if (!chat) return null
    return {
      usedPercent: clampPercent(100 - chat.percent_remaining),
      windowMinutes: null,
      resetsAt: resetAt,
    }
  })

  const quota = iife(() => {
    if (counts) return counts.remaining
    return token.quotaLimit ?? null
  })

  const credits =
    quota !== null
      ? {
          hasCredits: quota > 0,
          unlimited: false,
          balance: String(quota),
          total: counts?.total ?? null,
          used: counts?.used ?? null,
          remaining: counts?.remaining ?? quota,
        }
      : null

  return {
    snapshot: {
      primary,
      secondary: null,
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

function resolveUsageUrl(enterpriseUrl: string | undefined): string {
  if (!enterpriseUrl) return usageEndpoint
  const base = enterpriseUrl.startsWith("http") ? enterpriseUrl : `https://${enterpriseUrl}`
  const trimmed = base.replace(/\/$/, "")
  if (trimmed.endsWith("/api/v3")) return `${trimmed}/copilot_internal/user`
  return `${trimmed}/api/v3/copilot_internal/user`
}

function parseResetDate(value: string | undefined): number | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  if (Number.isNaN(ms)) return null
  return Math.floor(ms / 1000)
}

function snapshotFromToken(token: CopilotTokenMetadata): Snapshot | null {
  const planType = copilotSkuToPlan(token.sku)
  const quotaLimit = typeof token.quotaLimit === "number" && Number.isFinite(token.quotaLimit) ? token.quotaLimit : null
  const credits =
    quotaLimit !== null
      ? {
          hasCredits: quotaLimit > 0,
          unlimited: false,
          balance: String(quotaLimit),
          total: null,
          used: null,
          remaining: quotaLimit,
        }
      : null

  if (!credits && !planType) return null

  return {
    primary: null,
    secondary: null,
    tertiary: null,
    credits,
    planType,
    updatedAt: Date.now(),
  }
}

function fallbackPlan(sku: string): PlanType | null {
  const normalized = sku.toLowerCase()
  if (normalized.includes("free")) return "free"
  if (normalized.includes("individual") || normalized.includes("pro")) return "pro"
  if (normalized.includes("business")) return "business"
  if (normalized.includes("enterprise")) return "enterprise"
  return null
}

function clampPercent(value: number): number {
  if (Number.isNaN(value)) return 0
  if (value < 0) return 0
  if (value > 100) return 100
  return value
}
