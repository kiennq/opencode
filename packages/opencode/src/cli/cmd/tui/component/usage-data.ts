export type UsageWindow = {
  usedPercent: number
  windowMinutes: number | null
  resetsAt: number | null
}

export type UsageEntry = {
  provider: string
  displayName: string
  snapshot: {
    primary: UsageWindow | null
    secondary: UsageWindow | null
    tertiary: UsageWindow | null
    credits: {
      hasCredits: boolean
      unlimited: boolean
      balance: string | null
      total?: number | null
      used?: number | null
      remaining?: number | null
    } | null
    planType: string | null
    updatedAt: number
  }
}

export type UsageError = {
  provider: string
  message: string
}

export type UsageDisplayMode = "used" | "remaining"

export type UsageResult = {
  entries: UsageEntry[]
  error?: string
  errors: UsageError[]
  mode?: UsageDisplayMode
}
