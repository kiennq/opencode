import { afterEach, describe, expect, mock, test } from "bun:test"
import { CopilotAuthPlugin } from "../../src/plugin/copilot"

const hint = "x-opencode-copilot-initiator"
const anomalyClientID = "Ov23li8tweQw6odWQebz"
const copilotClientID = "Iv1.b507a08c87ecfe98"
const integrationID = "vscode-chat"

const auth = {
  type: "oauth" as const,
  refresh: "refresh-token",
  access: "access-token",
  expires: 0,
}

function input(overrides?: Partial<Parameters<typeof CopilotAuthPlugin>[0]>) {
  return {
    client: {
      auth: {
        set: mock(async () => ({})),
      },
      config: {
        get: mock(async () => ({ data: {} })),
      },
      session: {
        message: mock(async () => ({ data: { parts: [] } })),
        get: mock(async () => ({ data: {} })),
      },
    },
    project: {} as never,
    directory: "Q:/repos/opencode/packages/opencode",
    worktree: "Q:/repos/opencode",
    serverUrl: new URL("http://localhost"),
    version: "test",
    $: {} as never,
    ...overrides,
  } as Parameters<typeof CopilotAuthPlugin>[0]
}

function incoming(npm: string) {
  return {
    sessionID: "session_123",
    agent: "build",
    model: {
      providerID: "github-copilot",
      api: { npm },
    },
    provider: {} as never,
    message: {
      id: "message_123",
      sessionID: "session_123",
    },
  }
}

const fetcher = globalThis.fetch

afterEach(() => {
  globalThis.fetch = fetcher
})

describe("plugin.copilot", () => {
  test("chat.headers marks github-copilot child sessions as agent initiated", async () => {
    const client = {
      session: {
        message: mock(async () => ({ data: { parts: [] } })),
        get: mock(async () => ({ data: { parentID: "parent_123" } })),
      },
    }

    const hooks = await CopilotAuthPlugin(
      input({ client: client as unknown as Parameters<typeof CopilotAuthPlugin>[0]["client"] }),
    )
    const output = { headers: {} as Record<string, string> }

    await hooks["chat.headers"]?.(incoming("@ai-sdk/github-copilot") as never, output)

    expect(output.headers[hint]).toBe("agent")
    expect(output.headers["x-initiator"]).toBeUndefined()
  })

  test("chat.headers marks synthetic task summaries as agent initiated", async () => {
    const client = {
      session: {
        message: mock(async () => ({
          data: {
            parts: [
              {
                type: "text",
                synthetic: true,
                text: "Summarize the task tool output above and continue with your task.",
              },
            ],
          },
        })),
        get: mock(async () => ({ data: {} })),
      },
    }

    const hooks = await CopilotAuthPlugin(
      input({ client: client as unknown as Parameters<typeof CopilotAuthPlugin>[0]["client"] }),
    )
    const output = { headers: {} as Record<string, string> }

    await hooks["chat.headers"]?.(incoming("@ai-sdk/github-copilot") as never, output)

    expect(output.headers[hint]).toBe("agent")
    expect(output.headers["x-initiator"]).toBeUndefined()
  })

  test("loader fetch honors internal initiator hint for user-role continuations", async () => {
    const calls: RequestInit[] = []
    globalThis.fetch = mock(async (req: RequestInfo | URL, init?: RequestInit) => {
      const url = req.toString()
      calls.push(init ?? {})

      if (url.endsWith("/copilot_internal/v2/token")) {
        return new Response(
          JSON.stringify({
            token: "service-token",
            refresh_token: "refresh-token",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          }),
        )
      }

      return new Response("ok")
    }) as unknown as typeof fetch

    const expired = {
      ...auth,
      access: "",
      expires: 0,
    }
    const hooks = await CopilotAuthPlugin(input())
    const authHook = hooks.auth
    if (!authHook?.loader) throw new Error("missing loader")
    const loaded = await authHook.loader(async () => expired as never, { models: {} } as never)

    if (!loaded.fetch) throw new Error("missing fetch")
    await loaded.fetch("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      headers: {
        [hint]: "agent",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Continue if you have next steps" }],
      }),
    })

    expect(calls).toHaveLength(2)
    const headers = new Headers(calls[1]?.headers)
    expect(headers.get("x-initiator")).toBe("agent")
    expect(headers.get(hint)).toBeNull()
  })

  test("loader fetch treats internal media continuation prompts as agent initiated", async () => {
    const calls: RequestInit[] = []
    globalThis.fetch = mock(async (req: RequestInfo | URL, init?: RequestInit) => {
      const url = req.toString()
      calls.push(init ?? {})

      if (url.endsWith("/copilot_internal/v2/token")) {
        return new Response(
          JSON.stringify({
            token: "service-token",
            refresh_token: "refresh-token",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          }),
        )
      }

      return new Response("ok")
    }) as unknown as typeof fetch

    const expired = {
      ...auth,
      access: "",
      expires: 0,
    }
    const hooks = await CopilotAuthPlugin(input())
    const authHook = hooks.auth
    if (!authHook?.loader) throw new Error("missing loader")
    const loaded = await authHook.loader(async () => expired as never, { models: {} } as never)

    if (!loaded.fetch) throw new Error("missing fetch")
    await loaded.fetch("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Attached image(s) from tool result:" },
              { type: "image_url", image_url: { url: "https://example.com/image.png" } },
            ],
          },
        ],
      }),
    })

    expect(calls).toHaveLength(2)
    const headers = new Headers(calls[1]?.headers)
    expect(headers.get("x-initiator")).toBe("agent")
  })

  test("oauth callback uses github client with a single device flow", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    globalThis.fetch = mock(async (req: RequestInfo | URL, init?: RequestInit) => {
      const url = req.toString()
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      calls.push({ url, body })

      if (url.endsWith("/login/device/code")) {
        if (body.client_id === copilotClientID) {
          return new Response(
            JSON.stringify({
              verification_uri: "https://github.com/login/device",
              user_code: "MAIN-CODE",
              device_code: "main-device",
              interval: 0,
            }),
          )
        }
      }

      if (url.endsWith("/login/oauth/access_token")) {
        if (body.client_id === copilotClientID) {
          return new Response(JSON.stringify({ access_token: "device-token" }))
        }
      }

      return new Response("", { status: 404 })
    }) as unknown as typeof fetch

    const hooks = await CopilotAuthPlugin(input())
    const method = hooks.auth?.methods[0]
    if (!method || method.type !== "oauth") throw new Error("missing oauth method")

    const authz = await method.authorize({})
    if (authz.method !== "auto") throw new Error("expected auto auth")
    expect(authz.instructions).toContain("Enter code: MAIN-CODE")
    const result = await authz.callback()

    expect(result.type).toBe("success")
    if (result.type !== "success" || !("access" in result)) throw new Error("expected oauth success")
    expect(result.access).toBe("")
    expect(result.refresh).toBe("device-token")
    expect(result.usage).toBeUndefined()
    expect(calls.filter((call) => call.url.endsWith("/login/device/code"))).toHaveLength(1)
    expect(calls.filter((call) => call.url.endsWith("/login/oauth/access_token"))).toHaveLength(1)
    expect(calls.filter((call) => call.url.endsWith("/copilot_internal/v2/token"))).toHaveLength(0)
  })

  test("enterprise oauth callback uses github client with a single device flow by default", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    globalThis.fetch = mock(async (req: RequestInfo | URL, init?: RequestInit) => {
      const url = req.toString()
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      calls.push({ url, body })

      if (url === "https://company.ghe.com/login/device/code") {
        if (body.client_id === copilotClientID) {
          return new Response(
            JSON.stringify({
              verification_uri: "https://company.ghe.com/login/device",
              user_code: "MAIN-CODE",
              device_code: "main-device",
              interval: 0,
            }),
          )
        }
      }

      if (url === "https://company.ghe.com/login/oauth/access_token") {
        if (body.client_id === copilotClientID) {
          return new Response(JSON.stringify({ access_token: "device-token" }))
        }
      }

      return new Response("", { status: 404 })
    }) as unknown as typeof fetch

    const hooks = await CopilotAuthPlugin(input())
    const method = hooks.auth?.methods[0]
    if (!method || method.type !== "oauth") throw new Error("missing oauth method")

    const authz = await method.authorize({
      deploymentType: "enterprise",
      enterpriseUrl: "company.ghe.com",
    })
    if (authz.method !== "auto") throw new Error("expected auto auth")
    expect(authz.instructions).toBe("Enter code: MAIN-CODE")
    const result = await authz.callback()

    expect(result.type).toBe("success")
    if (result.type !== "success" || !("access" in result)) throw new Error("expected oauth success")
    expect(result.provider).toBe("github-copilot-enterprise")
    expect(result.enterpriseUrl).toBe("company.ghe.com")
    expect(result.access).toBe("")
    expect(result.refresh).toBe("device-token")
    expect(result.usage).toBeUndefined()
    expect(calls.filter((call) => call.url.endsWith("/login/device/code"))).toHaveLength(1)
    expect(calls.filter((call) => call.url.endsWith("/login/oauth/access_token"))).toHaveLength(1)
  })

  test("loader exchanges refresh token for Copilot bearer token", async () => {
    const calls: RequestInit[] = []
    globalThis.fetch = mock(async (req: RequestInfo | URL, init?: RequestInit) => {
      const url = req.toString()
      calls.push(init ?? {})

      if (url === "https://api.github.com/copilot_internal/v2/token") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer refresh-token")
        return new Response(
          JSON.stringify({
            token: "service-token",
            refresh_token: "service-refresh",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          }),
        )
      }

      return new Response("ok")
    }) as unknown as typeof fetch

    const expired = {
      ...auth,
      access: "",
      expires: 0,
    }
    const hooks = await CopilotAuthPlugin(input())
    const authHook = hooks.auth
    if (!authHook?.loader) throw new Error("missing loader")
    const loaded = await authHook.loader(async () => expired as never, { models: {} } as never)

    if (!loaded.fetch) throw new Error("missing fetch")
    await loaded.fetch("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    expect(calls).toHaveLength(2)
    const refresh = new Headers(calls[0]?.headers)
    expect(refresh.get("copilot-integration-id")).toBe(integrationID)
    const headers = new Headers(calls[1]?.headers)
    expect(headers.get("authorization")).toBe("Bearer service-token")
    expect(headers.get("copilot-integration-id")).toBe(integrationID)
  })

  test("oauth callback uses anomaly client and separate copilot usage token when configured", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const client = {
      config: {
        get: mock(async () => ({
          data: {
            provider: {
              "github-copilot": {
                options: {
                  client: "anomaly",
                },
              },
            },
          },
        })),
      },
      session: {
        message: mock(async () => ({ data: { parts: [] } })),
        get: mock(async () => ({ data: {} })),
      },
    }

    globalThis.fetch = mock(async (req: RequestInfo | URL, init?: RequestInit) => {
      const url = req.toString()
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      calls.push({ url, body })

      if (url.endsWith("/login/device/code")) {
        if (body.client_id === anomalyClientID) {
          return new Response(
            JSON.stringify({
              verification_uri: "https://github.com/login/device",
              user_code: "MAIN-CODE",
              device_code: "main-device",
              interval: 0,
            }),
          )
        }

        if (body.client_id === copilotClientID) {
          return new Response(
            JSON.stringify({
              verification_uri: "https://github.com/login/device",
              user_code: "USAGE-CODE",
              device_code: "usage-device",
              interval: 0,
            }),
          )
        }
      }

      if (url.endsWith("/login/oauth/access_token")) {
        if (body.client_id === anomalyClientID) {
          return new Response(JSON.stringify({ access_token: "device-token" }))
        }

        if (body.client_id === copilotClientID) {
          return new Response(JSON.stringify({ access_token: "usage-token" }))
        }
      }

      return new Response("", { status: 404 })
    }) as unknown as typeof fetch

    const hooks = await CopilotAuthPlugin(
      input({ client: client as unknown as Parameters<typeof CopilotAuthPlugin>[0]["client"] }),
    )
    const method = hooks.auth?.methods[0]
    if (!method || method.type !== "oauth") throw new Error("missing oauth method")

    const authz = await method.authorize({})
    if (authz.method !== "auto") throw new Error("expected auto auth")
    expect(authz.instructions).toContain("Enter code: MAIN-CODE")
    expect(authz.instructions).toContain("Enter code: USAGE-CODE")
    const result = await authz.callback()

    expect(result.type).toBe("success")
    if (result.type !== "success" || !("access" in result)) throw new Error("expected oauth success")
    expect(result.access).toBe("")
    expect(result.refresh).toBe("device-token")
    expect(result.usage).toBe("usage-token")
    expect(calls.filter((call) => call.url.endsWith("/login/device/code"))).toHaveLength(2)
    expect(calls.filter((call) => call.url.endsWith("/login/oauth/access_token"))).toHaveLength(2)
    expect(calls.filter((call) => call.url.endsWith("/copilot_internal/v2/token"))).toHaveLength(0)
  })

  test("oauth callback does not block on optional anomaly usage auth", async () => {
    const client = {
      config: {
        get: mock(async () => ({
          data: {
            provider: {
              "github-copilot": {
                options: {
                  client: "anomaly",
                },
              },
            },
          },
        })),
      },
      session: {
        message: mock(async () => ({ data: { parts: [] } })),
        get: mock(async () => ({ data: {} })),
      },
    }

    globalThis.fetch = mock(async (req: RequestInfo | URL, init?: RequestInit) => {
      const url = req.toString()
      const body = init?.body ? JSON.parse(String(init.body)) : {}

      if (url.endsWith("/login/device/code")) {
        if (body.client_id === anomalyClientID) {
          return new Response(
            JSON.stringify({
              verification_uri: "https://github.com/login/device",
              user_code: "MAIN-CODE",
              device_code: "main-device",
              interval: 0,
            }),
          )
        }

        if (body.client_id === copilotClientID) {
          return new Response(
            JSON.stringify({
              verification_uri: "https://github.com/login/device",
              user_code: "USAGE-CODE",
              device_code: "usage-device",
              interval: 0,
            }),
          )
        }
      }

      if (url.endsWith("/login/oauth/access_token")) {
        if (body.client_id === anomalyClientID) {
          return new Response(JSON.stringify({ access_token: "device-token" }))
        }

        if (body.client_id === copilotClientID) {
          return new Promise<Response>(() => {})
        }
      }

      return new Response("", { status: 404 })
    }) as unknown as typeof fetch

    const hooks = await CopilotAuthPlugin(
      input({ client: client as unknown as Parameters<typeof CopilotAuthPlugin>[0]["client"] }),
    )
    const method = hooks.auth?.methods[0]
    if (!method || method.type !== "oauth") throw new Error("missing oauth method")

    const authz = await method.authorize({})
    if (authz.method !== "auto") throw new Error("expected auto auth")

    const result = await Promise.race([
      authz.callback(),
      Promise.resolve().then(
        () =>
          new Promise<"timeout">((resolve) => {
            setTimeout(() => resolve("timeout"), 25)
          }),
      ),
    ])

    expect(result).not.toBe("timeout")
    if (result === "timeout") throw new Error("usage callback blocked oauth completion")
    expect(result.type).toBe("success")
    if (result.type !== "success" || !("access" in result)) throw new Error("expected oauth success")
    expect(result.access).toBe("")
    expect(result.refresh).toBe("device-token")
    expect(result.usage).toBeUndefined()
  })

  test("enterprise oauth callback also uses base copilot client override", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const client = {
      config: {
        get: mock(async () => ({
          data: {
            provider: {
              "github-copilot": {
                options: {
                  client: "anomaly",
                },
              },
            },
          },
        })),
      },
      session: {
        message: mock(async () => ({ data: { parts: [] } })),
        get: mock(async () => ({ data: {} })),
      },
    }

    globalThis.fetch = mock(async (req: RequestInfo | URL, init?: RequestInit) => {
      const url = req.toString()
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      calls.push({ url, body })

      if (url === "https://company.ghe.com/login/device/code") {
        if (body.client_id === anomalyClientID) {
          return new Response(
            JSON.stringify({
              verification_uri: "https://company.ghe.com/login/device",
              user_code: "MAIN-CODE",
              device_code: "main-device",
              interval: 0,
            }),
          )
        }

        if (body.client_id === copilotClientID) {
          return new Response(
            JSON.stringify({
              verification_uri: "https://company.ghe.com/login/device",
              user_code: "USAGE-CODE",
              device_code: "usage-device",
              interval: 0,
            }),
          )
        }
      }

      if (url === "https://company.ghe.com/login/oauth/access_token") {
        if (body.client_id === anomalyClientID) {
          return new Response(JSON.stringify({ access_token: "device-token" }))
        }

        if (body.client_id === copilotClientID) {
          return new Response(JSON.stringify({ access_token: "usage-token" }))
        }
      }

      return new Response("", { status: 404 })
    }) as unknown as typeof fetch

    const hooks = await CopilotAuthPlugin(
      input({ client: client as unknown as Parameters<typeof CopilotAuthPlugin>[0]["client"] }),
    )
    const method = hooks.auth?.methods[0]
    if (!method || method.type !== "oauth") throw new Error("missing oauth method")

    const authz = await method.authorize({
      deploymentType: "enterprise",
      enterpriseUrl: "company.ghe.com",
    })
    if (authz.method !== "auto") throw new Error("expected auto auth")
    expect(authz.instructions).toContain("Enter code: MAIN-CODE")
    expect(authz.instructions).toContain("Enter code: USAGE-CODE")
    const result = await authz.callback()

    expect(result.type).toBe("success")
    if (result.type !== "success" || !("access" in result)) throw new Error("expected oauth success")
    expect(result.provider).toBe("github-copilot-enterprise")
    expect(result.enterpriseUrl).toBe("company.ghe.com")
    expect(result.access).toBe("")
    expect(result.refresh).toBe("device-token")
    expect(result.usage).toBe("usage-token")
    expect(calls.filter((call) => call.url.endsWith("/login/device/code"))).toHaveLength(2)
  })
})
