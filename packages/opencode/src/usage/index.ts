export {
  planTypeSchema,
  rateLimitWindowSchema,
  creditsSnapshotSchema,
  snapshotSchema,
  type PlanType,
  type RateLimitWindow,
  type CreditsSnapshot,
  type Snapshot,
  type UsageFetchResult,
} from "./types"

export {
  UsageEvent,
  getUsage,
  updateUsage,
  clearUsage,
  resolveProvider,
  getProviderInfo,
  getAuthenticatedProviders,
  getProviderAuth,
} from "./store"

export { fetchChatgptUsage } from "./providers/openai"
export { fetchClaudeUsage } from "./providers/anthropic"
export { fetchCopilotUsage, parseCopilotAccessToken, copilotSkuToPlan } from "./providers/github-copilot"

import { fetchChatgptUsage } from "./providers/openai"
import { fetchClaudeUsage } from "./providers/anthropic"
import { fetchCopilotUsage, parseCopilotAccessToken, copilotSkuToPlan } from "./providers/github-copilot"
import {
  getUsage,
  updateUsage,
  clearUsage,
  resolveProvider,
  getProviderInfo,
  getAuthenticatedProviders,
  getProviderAuth,
} from "./store"
import { planTypeSchema, rateLimitWindowSchema, creditsSnapshotSchema, snapshotSchema } from "./types"

export const Usage = {
  planTypeSchema,
  rateLimitWindowSchema,
  creditsSnapshotSchema,
  snapshotSchema,
  getUsage,
  updateUsage,
  clearUsage,
  resolveProvider,
  getProviderInfo,
  getAuthenticatedProviders,
  getProviderAuth,
  fetchChatgptUsage,
  fetchClaudeUsage,
  fetchCopilotUsage,
  parseCopilotAccessToken,
  copilotSkuToPlan,
} as const
