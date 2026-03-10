import { Auth } from "../../auth"
import { ProviderQuota } from "."

// GitHub Copilot internal API response shape
interface Snapshot {
  slug: string
  percent_remaining: number
}

interface CopilotUser {
  copilot_plan_type?: string
  quota_snapshots?: Snapshot[]
  next_cycle_date_utc?: string
}

const LABELS: Record<string, string> = {
  premium_interactions: "Premium",
  chat: "Chat",
  completions: "Completions",
}

async function query(auth: Auth.Info): Promise<ProviderQuota.Info | null> {
  // Copilot plugin uses OAuth refresh token as the Bearer token
  const token = auth.type === "oauth" ? auth.refresh : auth.type === "api" ? auth.key : null
  if (!token) return null

  // Enterprise uses its own domain for the API
  const enterprise = auth.type === "oauth" ? (auth as any).enterpriseUrl : undefined
  const base = enterprise
    ? `https://${enterprise.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/api/v3`
    : "https://api.github.com"

  const res = await globalThis.fetch(`${base}/copilot_internal/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Copilot-Integration-Id": "vscode-chat",
    },
  })
  if (!res.ok) return null

  const data = (await res.json()) as CopilotUser
  if (!data.quota_snapshots?.length) return null

  const items = data.quota_snapshots
    .filter((s) => s.slug in LABELS)
    .map((s) => ({
      label: LABELS[s.slug]!,
      remaining: Math.round(s.percent_remaining),
      limit: 100,
    }))

  if (!items.length) return null

  return {
    items,
    reset: data.next_cycle_date_utc,
  }
}

export function register() {
  ProviderQuota.register("github-copilot", query)
  ProviderQuota.register("github-copilot-enterprise", query)
}
