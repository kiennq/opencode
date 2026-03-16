import z from "zod"
import { Auth } from "../auth"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { Storage } from "../storage/storage"
import { Log } from "../util/log"
import { getUsageProviderInfo, isUsageProvider, listUsageProviders, type UsageProviderInfo } from "./registry"
import { snapshotSchema, type Snapshot } from "./types"

const log = Log.create({ service: "usage" })

export const UsageEvent = {
  Updated: BusEvent.define(
    "usage.updated",
    z.object({
      provider: z.string(),
      snapshot: snapshotSchema,
    }),
  ),
}

export async function getUsage(provider: string): Promise<Snapshot | null> {
  return Storage.read<Snapshot>(storageKey(provider)).catch(() => null)
}

export async function updateUsage(provider: string, update: Partial<Snapshot>): Promise<Snapshot> {
  const existing = await getUsage(provider)
  const primary = update.primary !== undefined ? update.primary : (existing?.primary ?? null)
  const secondary = update.secondary !== undefined ? update.secondary : (existing?.secondary ?? null)
  const tertiary = update.tertiary !== undefined ? update.tertiary : (existing?.tertiary ?? null)
  const credits = update.credits !== undefined ? update.credits : (existing?.credits ?? null)
  const planType = update.planType !== undefined ? update.planType : (existing?.planType ?? null)
  const snapshot: Snapshot = {
    primary,
    secondary,
    tertiary,
    credits,
    planType,
    updatedAt: Date.now(),
  }

  await Storage.write(storageKey(provider), snapshot).catch((error) => {
    log.debug("usage write failed", { provider, error })
  })

  await Bus.publish(UsageEvent.Updated, { provider, snapshot }).catch((error) => {
    log.debug("usage publish failed", { provider, error })
  })

  return snapshot
}

export async function clearUsage(provider: string): Promise<void> {
  await Storage.remove(storageKey(provider))
}

export function resolveProvider(input: string): string | null {
  const normalized = input.trim().toLowerCase()
  if (isUsageProvider(normalized)) return normalized
  return null
}

export function getProviderInfo(provider: string): UsageProviderInfo | null {
  return getUsageProviderInfo(provider)
}

export async function getAuthenticatedProviders(auth?: Record<string, Auth.Info>): Promise<string[]> {
  const entries = auth ?? (await Auth.all())
  const providers = listUsageProviders()
  const result: string[] = []

  for (const provider of providers) {
    const matched = provider.authKeys.some((key) => {
      const providerAuth = entries[key]
      if (!providerAuth) return false
      if (provider.requiresOAuth && providerAuth.type !== "oauth") return false
      return true
    })
    if (matched) result.push(provider.id)
  }

  return result
}

export async function getProviderAuth(
  provider: string,
  auth?: Record<string, Auth.Info>,
): Promise<{ key: string; auth: Auth.Info } | null> {
  const info = getUsageProviderInfo(provider)
  if (!info) return null
  const entries = auth ?? (await Auth.all())

  for (const key of info.authKeys) {
    const providerAuth = entries[key]
    if (!providerAuth) continue
    if (info.requiresOAuth && providerAuth.type !== "oauth") continue
    return { key, auth: providerAuth }
  }

  return null
}

function storageKey(provider: string): string[] {
  return ["usage", provider]
}
