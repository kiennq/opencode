import z from "zod"
import { Auth } from "../../auth"

export namespace ProviderQuota {
  export const Item = z
    .object({
      label: z.string(),
      remaining: z.number().nullable(),
      limit: z.number().nullable(),
    })
    .meta({ ref: "ProviderQuotaItem" })

  export const Info = z
    .object({
      items: z.array(Item),
      reset: z.string().optional(),
    })
    .meta({ ref: "ProviderQuota" })
  export type Info = z.infer<typeof Info>

  type Fetcher = (auth: Auth.Info) => Promise<Info | null>
  const fetchers = new Map<string, Fetcher>()

  export function register(providerID: string, fetcher: Fetcher) {
    fetchers.set(providerID, fetcher)
  }

  export async function get(providerID: string): Promise<Info | null> {
    const fetcher = fetchers.get(providerID)
    if (!fetcher) return null
    const auth = await Auth.get(providerID)
    if (!auth) return null
    return fetcher(auth).catch(() => null)
  }

  export function has(providerID: string) {
    return fetchers.has(providerID)
  }
}

// Register built-in quota fetchers
import { register as copilot } from "./copilot"
copilot()
