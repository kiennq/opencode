import { createHash } from "node:crypto"
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Auth } from "../auth"
import { Usage } from "../usage"
import type { Snapshot as UsageSnapshot } from "../usage"
import { parseUsageCommand, resolveUsageProvider } from "../usage/command"
import { iife } from "../util/iife"

const USAGE_CACHE_TTL_MS = 5 * 60 * 1000
const inflightUsageFetch = new Map<string, Promise<{ snapshot: UsageSnapshot | null; error?: string }>>()

function fetchProviderUsage(input: {
  provider: string
  isCopilot: boolean
  accessToken: string
  usageToken: string
  oauth: {
    type: "oauth"
    access: string
    refresh: string
    expires: number
    usage?: string
    accountId?: string
    enterpriseUrl?: string
  }
  authKey: string
}) {
  const key = iife(() => {
    const account = input.oauth.accountId ?? ""
    const enterprise = input.oauth.enterpriseUrl ?? ""
    const access = fingerprint(input.accessToken)
    const usage = fingerprint(input.usageToken)
    const refresh = fingerprint(input.oauth.refresh)
    return `${input.provider}:${input.authKey}:${account}:${enterprise}:${access}:${usage}:${refresh}`
  })
  const existing = inflightUsageFetch.get(key)
  if (existing) return existing

  const task = (async () => {
    if (input.provider === "openai") {
      return Usage.fetchChatgptUsage(input.accessToken, input.oauth.accountId)
    }
    if (input.isCopilot) {
      return Usage.fetchCopilotUsage({
        access: input.accessToken,
        refresh: input.oauth.refresh,
        usage: input.usageToken,
        enterpriseUrl: input.oauth.enterpriseUrl,
      })
    }
    if (input.provider === "anthropic") {
      return Usage.fetchClaudeUsage(input.authKey, input.oauth)
    }
    return {
      snapshot: null,
      error: `${input.provider} usage is not supported`,
    }
  })().finally(() => {
    const current = inflightUsageFetch.get(key)
    if (current === task) inflightUsageFetch.delete(key)
  })

  inflightUsageFetch.set(key, task)
  return task
}

function fingerprint(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

const usageResponseSchema = z.object({
  entries: z.array(
    z.object({
      provider: z.string(),
      displayName: z.string(),
      snapshot: Usage.snapshotSchema,
    }),
  ),
  error: z.string().optional(),
  errors: z
    .array(
      z.object({
        provider: z.string(),
        message: z.string(),
      }),
    )
    .optional(),
  mode: z.enum(["used", "remaining"]).optional(),
})

const refreshSchema = z.preprocess((value) => {
  if (typeof value === "boolean") return value
  if (typeof value !== "string") return value
  const normalized = value.trim().toLowerCase()
  if (normalized === "true" || normalized === "1") return true
  if (normalized === "false" || normalized === "0") return false
  return undefined
}, z.boolean())

export function UsageRoutes() {
  return new Hono().get(
    "/",
    describeRoute({
      summary: "Get usage",
      description: "Fetch usage limits for authenticated providers.",
      operationId: "usage.get",
      responses: {
        200: {
          description: "Usage response",
          content: {
            "application/json": {
              schema: resolver(usageResponseSchema),
            },
          },
        },
      },
    }),
    validator(
      "query",
      z.object({
        provider: z.string().optional(),
        refresh: refreshSchema.optional(),
        command: z.string().optional(),
        modelProviderID: z.string().optional(),
        showUsageProviderScope: z.enum(["current", "all"]).optional(),
        showUsageValueMode: z.enum(["used", "remaining"]).optional(),
      }),
    ),
    async (c) => {
      const query = c.req.valid("query")
      let providerInput = query.provider?.trim()
      let refresh = query.refresh ?? false
      let mode = query.showUsageValueMode

      if (query.command) {
        const command = parseUsageCommand(query.command, {
          show_usage_provider_scope: query.showUsageProviderScope,
          show_usage_value_mode: query.showUsageValueMode,
        })
        if ("error" in command) {
          return c.json({
            entries: [],
            error: command.error,
          })
        }

        mode = command.mode
        const commandProvider = resolveUsageProvider({
          scope: command.scope,
          providerOverride: command.provider ?? null,
          modelProviderID: query.modelProviderID ?? null,
        })

        if (command.scope === "current" && !command.provider && !commandProvider) {
          return c.json({
            entries: [],
            error: "Usage tracking is not available for the current provider.",
            mode,
          })
        }

        providerInput = commandProvider ?? undefined
        refresh = true
      }

      const resolved = providerInput ? Usage.resolveProvider(providerInput) : null
      if (providerInput && !resolved) {
        return c.json({
          entries: [],
          error: `Unknown provider: "${providerInput}"`,
          mode,
        })
      }

      const auth = await Auth.all()
      const providers = resolved ? [resolved] : await Usage.getAuthenticatedProviders(auth)
      if (providers.length === 0) {
        return c.json({
          entries: [],
          error: "No OAuth providers with usage tracking are authenticated. Run: opencode auth login",
          mode,
        })
      }

      const providerTasks = providers.map(async (provider) => {
        const errors: string[] = []
        const providerErrors: Array<{ provider: string; message: string }> = []
        const pushError = (message: string) => {
          errors.push(message)
          providerErrors.push({ provider, message })
        }

        const info = Usage.getProviderInfo(provider)
        if (!info) {
          pushError(`Provider "${provider}" does not support usage tracking.`)
          return { provider, entry: null, errors, providerErrors }
        }

        const authEntry = await Usage.getProviderAuth(provider, auth)
        if (!authEntry) {
          pushError(`Not authenticated with ${info.displayName}. Run: opencode auth login`)
          return { provider, entry: null, errors, providerErrors }
        }
        const oauthAuth = authEntry.auth.type === "oauth" ? authEntry.auth : null
        if (info.requiresOAuth && !oauthAuth) {
          pushError(`Not authenticated with ${info.displayName} OAuth. Run: opencode auth login`)
          return { provider, entry: null, errors, providerErrors }
        }

        const oauth = oauthAuth
        if (!oauth) {
          pushError(`Missing OAuth access token for ${info.displayName}.`)
          return { provider, entry: null, errors, providerErrors }
        }

        const isCopilot = provider === "github-copilot" || provider === "github-copilot-enterprise"
        const accessToken = oauth.access
        if (!accessToken && !isCopilot) {
          pushError(`Missing OAuth access token for ${info.displayName}.`)
          return { provider, entry: null, errors, providerErrors }
        }

        const usageToken = isCopilot ? (oauth.usage ?? oauth.refresh) : accessToken
        if (!usageToken) {
          pushError(`Missing OAuth access token for ${info.displayName}.`)
          return { provider, entry: null, errors, providerErrors }
        }

        const cached = await Usage.getUsage(provider)
        const stale = !cached || Date.now() - cached.updatedAt > USAGE_CACHE_TTL_MS
        const snapshot = await (async () => {
          if (!refresh && !stale) return cached

          const fetched = await fetchProviderUsage({
            provider,
            isCopilot,
            accessToken,
            usageToken,
            oauth,
            authKey: authEntry.key,
          })

          const fetchedSnapshot = fetched.snapshot
          const detail = fetched.error ?? `Unable to refresh usage data for ${info.displayName}.`

          if (fetched.error) {
            if (cached) {
              pushError(`${detail} Showing cached results.`)
              return cached
            }
            if (fetchedSnapshot) {
              pushError(detail)
              await Usage.updateUsage(provider, fetchedSnapshot)
              return fetchedSnapshot
            }
            pushError(detail)
            return null
          }

          if (!fetchedSnapshot) {
            if (cached) {
              pushError(`${detail} Showing cached results.`)
              return cached
            }
            pushError(detail)
            return null
          }

          return Usage.updateUsage(provider, fetchedSnapshot)
        })()

        if (!snapshot) {
          return { provider, entry: null, errors, providerErrors }
        }

        return {
          provider,
          entry: { provider, displayName: info.displayName, snapshot },
          errors,
          providerErrors,
        }
      })

      const results = await Promise.all(providerTasks)
      const entries = results.flatMap((result) => (result.entry ? [result.entry] : []))
      const errors = results.flatMap((result) => result.errors)
      const providerErrors = results.flatMap((result) => result.providerErrors)

      return c.json({
        entries,
        error: errors.length > 0 ? errors.join("\n") : undefined,
        errors: providerErrors.length > 0 ? providerErrors : undefined,
        mode,
      })
    },
  )
}
