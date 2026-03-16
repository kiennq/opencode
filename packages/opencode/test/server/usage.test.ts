import { describe, expect, test } from "bun:test"
import { Auth } from "../../src/auth"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Storage } from "../../src/storage/storage"
import { Usage, type Snapshot } from "../../src/usage"
import { iife } from "../../src/util/iife"
import { Log } from "../../src/util/log"

Log.init({ print: false })
const app = Server.createApp({})
const authHeader = iife(() => {
  const password = process.env.OPENCODE_SERVER_PASSWORD
  if (!password) return null
  const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
})

function request(path: string, init?: RequestInit) {
  if (!authHeader) return app.request(path, init)
  const headers = new Headers(init?.headers ?? {})
  headers.set("Authorization", authHeader)
  return app.request(path, {
    ...init,
    headers,
  })
}

const openaiUsageResponse = {
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 10,
      limit_window_seconds: 5 * 60 * 60,
      reset_after_seconds: 60,
      reset_at: 1_700_000_000,
    },
    secondary_window: {
      used_percent: 25,
      limit_window_seconds: 7 * 24 * 60 * 60,
      reset_after_seconds: 120,
      reset_at: 1_700_604_800,
    },
  },
  credits: {
    has_credits: true,
    unlimited: false,
    balance: "12.34",
  },
}

function cachedOpenaiSnapshot(): Snapshot {
  return {
    primary: { usedPercent: 10, windowMinutes: 300, resetsAt: 1_700_000_000 },
    secondary: null,
    tertiary: null,
    credits: null,
    planType: "plus",
    updatedAt: Date.now(),
  }
}

async function withInstance(run: () => Promise<void>) {
  const originalProvide = Instance.provide
  Instance.provide = async (input) => input.fn()
  try {
    await run()
  } finally {
    Instance.provide = originalProvide
  }
}

describe("/usage", () => {
  test("returns openai usage with org header", async () => {
    const originalFetch = globalThis.fetch
    const accountId = "acct_123"
    const seen = { accountId: "" }

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url === "https://chatgpt.com/backend-api/wham/usage") {
        const headers = new Headers(init?.headers ?? {})
        seen.accountId = headers.get("ChatGPT-Account-Id") ?? ""
        return Promise.resolve(new Response(JSON.stringify(openaiUsageResponse), { status: 200 }))
      }
      return Promise.resolve(new Response("", { status: 404 }))
    }) as typeof fetch

    try {
      const result = await Usage.fetchChatgptUsage("codex-token", accountId)
      const snapshot = result.snapshot
      expect(snapshot?.primary?.usedPercent).toBe(10)
      expect(snapshot?.secondary?.usedPercent).toBe(25)
      expect(seen.accountId).toBe(accountId)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("refresh=false uses cache without calling fetch", async () => {
    const originalFetch = globalThis.fetch
    const originalAuthAll = Auth.all
    const calls = { count: 0 }

    Auth.all = (async () => ({
      openai: {
        type: "oauth" as const,
        access: "codex-token",
        refresh: "codex-refresh",
        expires: 0,
      },
    })) as typeof Auth.all

    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = input.toString()
      if (url === "https://chatgpt.com/backend-api/wham/usage") {
        calls.count += 1
      }
      return Promise.resolve(new Response("", { status: 404 }))
    }) as typeof fetch

    try {
      await withInstance(async () => {
        await Usage.clearUsage("openai")
        await Storage.write(["usage", "openai"], cachedOpenaiSnapshot())

        const response = await request("/usage?provider=openai&refresh=false")
        expect(response.status).toBe(200)
        const body = (await response.json()) as { entries: Array<{ snapshot: { planType: string | null } }> }
        expect(body.entries.length).toBe(1)
        expect(body.entries[0].snapshot.planType).toBe("plus")
        expect(calls.count).toBe(0)
      })
    } finally {
      globalThis.fetch = originalFetch
      Auth.all = originalAuthAll
    }
  })

  test("missing auth suggests login command", async () => {
    const originalAuthAll = Auth.all

    Auth.all = (async () => ({})) as typeof Auth.all

    try {
      await withInstance(async () => {
        const response = await request("/usage?provider=openai")
        expect(response.status).toBe(200)
        const body = (await response.json()) as { error?: string }
        expect(body.error).toContain("opencode auth login")
        expect(body.error).not.toContain("opencode auth add")
      })
    } finally {
      Auth.all = originalAuthAll
    }
  })

  test("server parses usage command query and returns mode", async () => {
    const originalFetch = globalThis.fetch
    const originalAuthAll = Auth.all

    Auth.all = (async () => ({
      openai: {
        type: "oauth" as const,
        access: "codex-token",
        refresh: "codex-refresh",
        expires: 0,
      },
    })) as typeof Auth.all

    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = input.toString()
      if (url === "https://chatgpt.com/backend-api/wham/usage") {
        return Promise.resolve(new Response(JSON.stringify(openaiUsageResponse), { status: 200 }))
      }
      return Promise.resolve(new Response("", { status: 404 }))
    }) as typeof fetch

    try {
      await withInstance(async () => {
        await Usage.clearUsage("openai")
        const response = await request(
          "/usage?command=%2Fusage%20--remaining%20--current&modelProviderID=openai&showUsageProviderScope=current&showUsageValueMode=used",
        )
        expect(response.status).toBe(200)
        const body = (await response.json()) as {
          entries: Array<{ provider: string }>
          mode?: string
          error?: string
        }
        expect(body.error).toBeUndefined()
        expect(body.mode).toBe("remaining")
        expect(body.entries.length).toBe(1)
        expect(body.entries[0].provider).toBe("openai")
      })
    } finally {
      globalThis.fetch = originalFetch
      Auth.all = originalAuthAll
    }
  })

  test("server returns usage command parse errors", async () => {
    await withInstance(async () => {
      const response = await request("/usage?command=%2Fusage%20--all%20--current")
      expect(response.status).toBe(200)
      const body = (await response.json()) as { entries: Array<unknown>; error?: string }
      expect(body.entries.length).toBe(0)
      expect(body.error).toContain("Choose only one of --all or --current")
    })
  })

  test("concurrent refresh requests share one provider fetch", async () => {
    const originalFetch = globalThis.fetch
    const originalAuthAll = Auth.all
    const calls = { count: 0 }

    Auth.all = (async () => ({
      openai: {
        type: "oauth" as const,
        access: "codex-token",
        refresh: "codex-refresh",
        expires: 0,
      },
    })) as typeof Auth.all

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = input.toString()
      if (url === "https://chatgpt.com/backend-api/wham/usage") {
        calls.count += 1
        await Bun.sleep(25)
        return new Response(JSON.stringify(openaiUsageResponse), { status: 200 })
      }
      return new Response("", { status: 404 })
    }) as typeof fetch

    try {
      await withInstance(async () => {
        await Usage.clearUsage("openai")

        const [first, second] = await Promise.all([
          request("/usage?provider=openai&refresh=true"),
          request("/usage?provider=openai&refresh=true"),
        ])

        expect(first.status).toBe(200)
        expect(second.status).toBe(200)
        expect(calls.count).toBe(1)
      })
    } finally {
      globalThis.fetch = originalFetch
      Auth.all = originalAuthAll
    }
  })

  test("concurrent refresh requests with rotated auth do not dedupe", async () => {
    const originalFetch = globalThis.fetch
    const originalAuthAll = Auth.all
    const calls = { count: 0 }
    let authCalls = 0

    Auth.all = (async () => {
      authCalls += 1
      return {
        openai: {
          type: "oauth" as const,
          access: "codex-token",
          refresh: authCalls === 1 ? "refresh-a" : "refresh-b",
          expires: 0,
        },
      }
    }) as typeof Auth.all

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = input.toString()
      if (url === "https://chatgpt.com/backend-api/wham/usage") {
        calls.count += 1
        await Bun.sleep(25)
        return new Response(JSON.stringify(openaiUsageResponse), { status: 200 })
      }
      return new Response("", { status: 404 })
    }) as typeof fetch

    try {
      await withInstance(async () => {
        await Usage.clearUsage("openai")

        const [first, second] = await Promise.all([
          request("/usage?provider=openai&refresh=true"),
          request("/usage?provider=openai&refresh=true"),
        ])

        expect(first.status).toBe(200)
        expect(second.status).toBe(200)
        expect(calls.count).toBe(2)
      })
    } finally {
      globalThis.fetch = originalFetch
      Auth.all = originalAuthAll
    }
  })

  test("copilot uses copilot_internal usage with reset date", async () => {
    const originalFetch = globalThis.fetch
    const originalAuthAll = Auth.all
    const resetDate = "2026-02-01T00:00:00Z"
    const resetAt = Math.floor(new Date(resetDate).getTime() / 1000)
    const seen = { auth: "", integration: "" }

    Auth.all = (async () => ({
      "github-copilot": {
        type: "oauth" as const,
        access: "copilot-token",
        refresh: "copilot-token",
        usage: "copilot-usage-token",
        expires: 0,
      },
    })) as typeof Auth.all

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url === "https://api.github.com/copilot_internal/user") {
        const headers = new Headers(init?.headers ?? {})
        seen.auth = headers.get("Authorization") ?? ""
        seen.integration = headers.get("Copilot-Integration-Id") ?? ""
        return Promise.resolve(
          new Response(
            JSON.stringify({
              quota_snapshots: {
                premium_interactions: {
                  entitlement: 100,
                  remaining: 40,
                  percent_remaining: 40,
                  quota_id: "premium",
                },
                chat: {
                  entitlement: 200,
                  remaining: 50,
                  percent_remaining: 25,
                  quota_id: "chat",
                },
              },
              copilot_plan: "copilot_for_individual",
              quota_reset_date: resetDate,
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(new Response("", { status: 404 }))
    }) as typeof fetch

    try {
      await withInstance(async () => {
        await Usage.clearUsage("github-copilot")
        const response = await request("/usage?provider=github-copilot")
        expect(response.status).toBe(200)
        const body = (await response.json()) as {
          entries: Array<{ snapshot: Snapshot }>
        }
        expect(body.entries.length).toBe(1)
        const snapshot = body.entries[0].snapshot
        expect(snapshot.primary?.usedPercent).toBe(75)
        expect(snapshot.primary?.resetsAt).toBe(resetAt)
        expect(snapshot.secondary).toBeNull()
        expect(snapshot.credits?.balance).toBe("40")
        expect(snapshot.credits?.total).toBe(100)
        expect(snapshot.credits?.used).toBe(60)
        expect(snapshot.credits?.remaining).toBe(40)
        expect(seen.auth).toBe("token copilot-usage-token")
        expect(seen.integration).toBe("vscode-chat")
      })
    } finally {
      globalThis.fetch = originalFetch
      Auth.all = originalAuthAll
    }
  })

  test("copilot falls back to refresh token when usage token is absent", async () => {
    const originalAuthAll = Auth.all
    const originalFetch = globalThis.fetch
    const seen = { auth: "" }

    Auth.all = (async () => ({
      "github-copilot": {
        type: "oauth" as const,
        access: "",
        refresh: "copilot-refresh-token",
        expires: 0,
      },
    })) as typeof Auth.all

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url === "https://api.github.com/copilot_internal/user") {
        seen.auth = new Headers(init?.headers ?? {}).get("Authorization") ?? ""
        return Promise.resolve(
          new Response(
            JSON.stringify({
              quota_snapshots: {
                premium_interactions: {
                  entitlement: 50,
                  remaining: 25,
                  percent_remaining: 50,
                  quota_id: "premium",
                },
                chat: {
                  entitlement: 100,
                  remaining: 25,
                  percent_remaining: 25,
                  quota_id: "chat",
                },
              },
              copilot_plan: "copilot_for_individual",
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(new Response("", { status: 404 }))
    }) as typeof fetch

    try {
      await withInstance(async () => {
        await Usage.clearUsage("github-copilot")
        const response = await request("/usage?provider=github-copilot")
        expect(response.status).toBe(200)
        const body = (await response.json()) as { entries: Array<{ snapshot: Snapshot }>; error?: string }
        expect(body.error).toBeUndefined()
        expect(body.entries.length).toBe(1)
        expect(body.entries[0].snapshot.primary?.usedPercent).toBe(75)
        expect(seen.auth).toBe("token copilot-refresh-token")
      })
    } finally {
      globalThis.fetch = originalFetch
      Auth.all = originalAuthAll
    }
  })

  test("fetch failure returns cached snapshot with error line", async () => {
    const originalFetch = globalThis.fetch
    const originalAuthAll = Auth.all

    Auth.all = (async () => ({
      openai: {
        type: "oauth" as const,
        access: "codex-token",
        refresh: "codex-refresh",
        expires: 0,
      },
    })) as typeof Auth.all

    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = input.toString()
      if (url === "https://chatgpt.com/backend-api/wham/usage") {
        return Promise.resolve(new Response("", { status: 500 }))
      }
      return Promise.resolve(new Response("", { status: 404 }))
    }) as typeof fetch

    try {
      await withInstance(async () => {
        await Usage.clearUsage("openai")
        await Storage.write(["usage", "openai"], cachedOpenaiSnapshot())

        const response = await request("/usage?provider=openai&refresh=true")
        expect(response.status).toBe(200)
        const body = (await response.json()) as {
          entries: Array<unknown>
          error?: string
          errors?: Array<{ provider: string; message: string }>
        }
        expect(body.entries.length).toBe(1)
        expect(body.error).toContain("Showing cached results")
        expect(body.errors?.[0].provider).toBe("openai")
      })
    } finally {
      globalThis.fetch = originalFetch
      Auth.all = originalAuthAll
    }
  })

  test("copilot fallback does not overwrite cache", async () => {
    const originalAuthAll = Auth.all
    const originalFetch = globalThis.fetch

    Auth.all = (async () => ({
      "github-copilot": {
        type: "oauth" as const,
        access: "sku=copilot_for_individual;cq=80",
        refresh: "copilot-token",
        usage: "copilot-usage-token",
        expires: 0,
      },
    })) as typeof Auth.all

    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = input.toString()
      if (url === "https://api.github.com/copilot_internal/user") {
        return Promise.resolve(new Response("", { status: 500 }))
      }
      return Promise.resolve(new Response("", { status: 404 }))
    }) as typeof fetch

    try {
      await withInstance(async () => {
        await Usage.updateUsage("github-copilot", {
          primary: { usedPercent: 10, windowMinutes: 60, resetsAt: 1 },
        })

        const response = await request("/usage?provider=github-copilot&refresh=true")
        expect(response.status).toBe(200)
        const body = (await response.json()) as {
          entries: Array<{ snapshot: Snapshot }>
          errors?: Array<{ provider: string; message: string }>
        }
        expect(body.entries[0].snapshot.primary?.usedPercent).toBe(10)
        expect(body.errors?.[0].message).toContain("Copilot usage request failed")

        const stored = await Usage.getUsage("github-copilot")
        expect(stored?.primary?.usedPercent).toBe(10)
      })
    } finally {
      globalThis.fetch = originalFetch
      Auth.all = originalAuthAll
    }
  })

  test("updateUsage overwrites null fields", async () => {
    await Usage.clearUsage("openai")
    await Usage.updateUsage("openai", {
      primary: { usedPercent: 10, windowMinutes: 60, resetsAt: 123 },
      secondary: { usedPercent: 20, windowMinutes: 120, resetsAt: 456 },
      credits: { hasCredits: true, unlimited: false, balance: "50" },
      planType: "plus",
    })

    const updated = await Usage.updateUsage("openai", {
      secondary: null,
      credits: null,
    })

    expect(updated.secondary).toBeNull()
    expect(updated.credits).toBeNull()
    const stored = await Usage.getUsage("openai")
    expect(stored?.secondary).toBeNull()
    expect(stored?.credits).toBeNull()
  })

  test("claude extra usage maps to credits", async () => {
    const originalFetch = globalThis.fetch
    const auth = {
      type: "oauth" as const,
      access: "claude-token",
      refresh: "claude-refresh",
      expires: 0,
    }

    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = input.toString()
      if (url === "https://api.anthropic.com/api/oauth/usage") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              five_hour: { utilization: 0, resets_at: null },
              seven_day: { utilization: 50, resets_at: null },
              extra_usage: {
                is_enabled: true,
                monthly_limit: 2000,
                used_credits: 1900,
                utilization: 95,
              },
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(new Response("", { status: 404 }))
    }) as typeof fetch

    try {
      const result = await Usage.fetchClaudeUsage("anthropic", auth)
      const snapshot = result.snapshot
      expect(snapshot?.primary?.usedPercent).toBe(0)
      expect(snapshot?.secondary?.usedPercent).toBe(50)
      expect(snapshot?.credits?.balance).toBe("100")
      expect(snapshot?.credits?.hasCredits).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
