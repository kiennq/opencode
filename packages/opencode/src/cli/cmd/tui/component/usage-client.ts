import { useLocal } from "@tui/context/local"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { resolveUsageProvider, type UsageDisplayMode, type UsageScope } from "@/usage/command"
import { createMemo, createResource, onCleanup, type Accessor } from "solid-js"
import type { UsageResult } from "./usage-data"

type UsageConfig = {
  tui?: {
    show_usage_provider_scope?: UsageScope
  }
}

type UsageResource = {
  data: Accessor<UsageResult | undefined>
  refetch: () => void
  scope: () => UsageScope
  provider: () => string | null
}

export async function fetchUsage(
  sdk: ReturnType<typeof useSDK>,
  params: {
    provider?: string
    refresh?: boolean
    command?: string
    modelProviderID?: string
    showUsageProviderScope?: UsageScope
    showUsageValueMode?: UsageDisplayMode
  },
): Promise<UsageResult> {
  const query = new URLSearchParams()
  if (params.provider) query.set("provider", params.provider)
  if (params.refresh !== undefined) query.set("refresh", String(params.refresh))
  if (params.command) query.set("command", params.command)
  if (params.modelProviderID) query.set("modelProviderID", params.modelProviderID)
  if (params.showUsageProviderScope) query.set("showUsageProviderScope", params.showUsageProviderScope)
  if (params.showUsageValueMode) query.set("showUsageValueMode", params.showUsageValueMode)

  const suffix = query.size > 0 ? `?${query.toString()}` : ""
  const response = await sdk.fetch(`${sdk.url}/usage${suffix}`)
  const data = (await response.json().catch(() => undefined)) as UsageResult | undefined
  return {
    entries: data?.entries ?? [],
    errors: data?.errors ?? [],
    error: data?.error,
    mode: data?.mode,
  }
}

export function useUsageResource(): UsageResource {
  const sync = useSync()
  const local = useLocal()
  const sdk = useSDK()

  const scope = createMemo<UsageScope>(
    () => (sync.data.config as UsageConfig).tui?.show_usage_provider_scope ?? "current",
  )
  const provider = createMemo(() =>
    resolveUsageProvider({
      scope: scope(),
      modelProviderID: local.model.current()?.providerID ?? null,
    }),
  )

  const [data, { refetch }] = createResource(
    () => ({ scope: scope(), provider: provider() }),
    async ({ scope, provider: id }) => {
      if (scope === "current" && !id) {
        return { entries: [], errors: [] }
      }
      return fetchUsage(sdk, { provider: id ?? undefined, refresh: false })
    },
    { initialValue: { entries: [], errors: [] } },
  )

  const unsubscribe = sdk.event.listen((e) => {
    const evt = e.details as typeof e.details | { type: "usage.updated"; properties: { provider: string } }
    if (evt.type !== "usage.updated") return
    const currentScope = scope()
    const currentProvider = provider()
    if (currentScope === "current" && currentProvider && evt.properties.provider !== currentProvider) return
    refetch()
  })
  onCleanup(unsubscribe)

  return {
    data,
    refetch,
    scope,
    provider,
  }
}
