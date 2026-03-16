export type UsageProviderInfo = {
  authKeys: readonly string[]
  displayName: string
  requiresOAuth: boolean
}

export const usageProviders = {
  openai: {
    authKeys: ["openai"],
    displayName: "OpenAI ChatGPT",
    requiresOAuth: true,
  },
  "github-copilot": {
    authKeys: ["github-copilot"],
    displayName: "GitHub Copilot",
    requiresOAuth: true,
  },
  "github-copilot-enterprise": {
    authKeys: ["github-copilot-enterprise"],
    displayName: "GitHub Copilot Enterprise",
    requiresOAuth: true,
  },
  anthropic: {
    authKeys: ["anthropic"],
    displayName: "Anthropic Claude",
    requiresOAuth: true,
  },
} as const

export type UsageProviderId = keyof typeof usageProviders

export function isUsageProvider(provider: string): provider is UsageProviderId {
  return provider in usageProviders
}

export function getUsageProviderInfo(provider: string): UsageProviderInfo | null {
  if (!isUsageProvider(provider)) return null
  return usageProviders[provider]
}

export function listUsageProviders(): Array<{ id: UsageProviderId } & UsageProviderInfo> {
  const providers = Object.keys(usageProviders) as UsageProviderId[]
  return providers.map((id) => ({ id, ...usageProviders[id] }))
}
