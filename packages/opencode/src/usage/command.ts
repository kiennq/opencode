import { isUsageProvider } from "./registry"

export type UsageScope = "current" | "all"
export type UsageDisplayMode = "used" | "remaining"

type UsageConfig = {
  show_usage_provider_scope?: UsageScope
  show_usage_value_mode?: UsageDisplayMode
}

export type UsageCommandResult =
  | {
      error: string
    }
  | {
      provider: string | undefined
      scope: UsageScope
      mode: UsageDisplayMode
    }

export function parseUsageCommand(command: string, config?: UsageConfig): UsageCommandResult {
  const args = command.trim().split(/\s+/).slice(1)
  const provider = args.find((part) => !part.startsWith("-"))
  const hasAll = args.includes("--all")
  const hasCurrent = args.includes("--current")
  const hasUsed = args.includes("--used")
  const hasRemaining = args.includes("--remaining")

  if (hasAll && hasCurrent) {
    return {
      error: "Choose only one of --all or --current.",
    }
  }

  if (hasUsed && hasRemaining) {
    return {
      error: "Choose only one of --used or --remaining.",
    }
  }

  return {
    provider: hasAll || hasCurrent ? undefined : provider,
    scope: hasAll ? "all" : hasCurrent ? "current" : (config?.show_usage_provider_scope ?? "current"),
    mode: hasUsed ? "used" : hasRemaining ? "remaining" : (config?.show_usage_value_mode ?? "used"),
  }
}

export function resolveUsageProvider(options: {
  scope: UsageScope
  providerOverride?: string | null
  modelProviderID?: string | null
}): string | null {
  if (options.providerOverride) return options.providerOverride
  if (options.scope !== "current") return null
  const modelProviderID = options.modelProviderID
  if (!modelProviderID) return null
  const normalized = modelProviderID.trim().toLowerCase()
  if (!isUsageProvider(normalized)) return null
  return normalized
}
