type Credits = {
  hasCredits: boolean
  unlimited: boolean
  balance: string | null
  total?: number | null
  used?: number | null
  remaining?: number | null
}

export type UsageSlot = "primary" | "secondary" | "tertiary"
export type UsageDisplayMode = "used" | "remaining"

export function formatUsageWindowLabel(provider: string, slot: UsageSlot, windowMinutes: number | null): string {
  const base = formatUsageSlotLabel(provider, slot)
  return formatWindowLabel(base, windowMinutes)
}

export function formatUsageSlotLabel(provider: string, slot: UsageSlot): string {
  if (provider === "openai") {
    if (slot === "primary") return "5h"
    if (slot === "secondary") return "Weekly"
    return "Usage"
  }
  if (provider.startsWith("github-copilot")) {
    if (slot === "primary") return "Monthly"
    if (slot === "secondary") return "Premium Requests"
    return "Usage"
  }
  if (provider === "anthropic") {
    if (slot === "primary") return "5h"
    if (slot === "secondary") return "Weekly"
    return "Usage"
  }
  return "Usage"
}

export function formatPlanType(planType: string | null): string | null {
  if (!planType) return null
  const normalized = planType.replace(/_/g, " ")
  const parts: string[] = []
  for (const part of normalized.split(" ")) {
    if (!part) continue
    parts.push(part.slice(0, 1).toUpperCase() + part.slice(1))
  }
  return parts.join(" ")
}

export function formatCreditsLabel(
  provider: string,
  credits: Credits,
  options?: { mode?: UsageDisplayMode; slot?: UsageSlot },
): string {
  const mode = options?.mode ?? "used"
  if (provider.startsWith("github-copilot")) {
    const slot = options?.slot ?? "secondary"
    const label = formatUsageSlotLabel(provider, slot)
    if (credits.unlimited) return `${label}: Unlimited`
    const remainingCount = creditCount(credits.remaining) ?? creditCount(parseBalance(credits.balance))
    const usedCount = creditCount(credits.used)

    if (mode === "remaining") {
      if (remainingCount !== null) return `${label} Remaining: ${remainingCount}`
      if (!credits.hasCredits) return `${label}: Exhausted`
      return `${label}: Available`
    }

    if (usedCount !== null) return `${label} Used: ${usedCount}`
    if (!credits.hasCredits) return `${label} Used: All`
    return `${label} Used: Unknown`
  }
  if (provider === "anthropic") return `Extra Usage Balance: ${formatCredits(credits)}`
  return `Credits Balance: ${formatCredits(credits)}`
}

type UsageTheme = {
  error: unknown
  warning: unknown
  success: unknown
}

export function formatUsageResetShort(resetAt: number | null): string {
  if (!resetAt) return ""
  const now = Math.floor(Date.now() / 1000)
  const diff = resetAt - now
  if (diff <= 0) return "refreshing"
  if (diff < 60) return `${diff}s`
  if (diff < 3600) return `${Math.round(diff / 60)}m`
  if (diff < 86400) return `${Math.round(diff / 3600)}h`
  return `${Math.round(diff / 86400)}d`
}

export function formatUsageResetLong(resetAt: number): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = resetAt - now
  if (diff <= 0) return "now"
  if (diff < 60) return `in ${diff} seconds`
  if (diff < 3600) return `in ${Math.round(diff / 60)} minutes`
  if (diff < 86400) return `in ${Math.round(diff / 3600)} hours`
  return `in ${Math.round(diff / 86400)} days`
}

export function usageDisplay(
  usedPercent: number,
  mode: UsageDisplayMode,
): { percent: number; label: UsageDisplayMode } {
  const used = clampPercent(usedPercent)
  if (mode === "remaining") {
    return {
      percent: 100 - used,
      label: "remaining",
    }
  }
  return {
    percent: used,
    label: "used",
  }
}

export function usageBarString(percent: number, width = 10): string {
  const clamped = clampPercent(percent)
  const filled = Math.round((clamped / 100) * width)
  return "█".repeat(filled) + "░".repeat(width - filled)
}

export function usageBarColor<T extends UsageTheme>(
  percent: number,
  theme: T,
): T["error"] | T["warning"] | T["success"] {
  if (percent >= 90) return theme.error
  if (percent >= 70) return theme.warning
  return theme.success
}

function formatWindowLabel(base: string, windowMinutes: number | null): string {
  if (!windowMinutes) return base
  if (base !== "Hourly" && base !== "Weekly") return base
  const minutesPerHour = 60
  const minutesPerDay = 24 * minutesPerHour
  const minutesPerWeek = 7 * minutesPerDay
  if (windowMinutes >= minutesPerWeek) return "Weekly"

  if (windowMinutes % minutesPerHour === 0) {
    const hours = Math.max(1, Math.round(windowMinutes / minutesPerHour))
    if (hours === 1) return "Hourly"
    return `${hours}h`
  }

  if (windowMinutes < minutesPerHour) return `${windowMinutes}m`
  const hours = Math.max(1, Math.round(windowMinutes / minutesPerHour))
  return `${hours}h`
}

function clampPercent(value: number): number {
  if (Number.isNaN(value)) return 0
  if (value < 0) return 0
  if (value > 100) return 100
  return value
}

function formatCredits(credits: Credits): string {
  if (!credits.hasCredits) return "None"
  if (credits.unlimited) return "Unlimited"
  if (credits.balance) {
    const numeric = Number(credits.balance)
    if (!Number.isNaN(numeric)) return String(Math.floor(numeric))
    return credits.balance
  }
  return "Available"
}

function parseBalance(value: string | null): number | null {
  if (!value) return null
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  return numeric
}

function creditCount(value: number | null | undefined): number | null {
  if (typeof value !== "number") return null
  if (!Number.isFinite(value)) return null
  return Math.max(0, Math.floor(value))
}
