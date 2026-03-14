import { afterEach, describe, expect, mock, test } from "bun:test"
import { CopilotAuthPlugin } from "../../src/plugin/copilot"

const hint = "x-opencode-copilot-initiator"

const auth = {
  type: "oauth" as const,
  refresh: "refresh-token",
  access: "access-token",
  expires: 0,
}

function input(overrides?: Partial<Parameters<typeof CopilotAuthPlugin>[0]>) {
  return {
    client: {
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
    globalThis.fetch = mock(async (_req: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {})
      return new Response("ok")
    }) as unknown as typeof fetch

    const hooks = await CopilotAuthPlugin(input())
    const authHook = hooks.auth
    if (!authHook?.loader) throw new Error("missing loader")
    const loaded = await authHook.loader(async () => auth as never, { models: {} } as never)

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

    expect(calls).toHaveLength(1)
    const headers = new Headers(calls[0]?.headers)
    expect(headers.get("x-initiator")).toBe("agent")
    expect(headers.get(hint)).toBeNull()
  })

  test("loader fetch treats internal media continuation prompts as agent initiated", async () => {
    const calls: RequestInit[] = []
    globalThis.fetch = mock(async (_req: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {})
      return new Response("ok")
    }) as unknown as typeof fetch

    const hooks = await CopilotAuthPlugin(input())
    const authHook = hooks.auth
    if (!authHook?.loader) throw new Error("missing loader")
    const loaded = await authHook.loader(async () => auth as never, { models: {} } as never)

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

    expect(calls).toHaveLength(1)
    const headers = new Headers(calls[0]?.headers)
    expect(headers.get("x-initiator")).toBe("agent")
  })
})
