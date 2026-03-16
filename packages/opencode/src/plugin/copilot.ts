import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Installation } from "@/installation"
import { iife } from "@/util/iife"
import { setTimeout as sleep } from "node:timers/promises"

const ANOMALY_CLIENT_ID = "Ov23li8tweQw6odWQebz"
const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98"
const OAUTH_SCOPE = "read:user"
const INITIATOR = "x-opencode-copilot-initiator"
const COPILOT_HEADERS = {
  "Editor-Version": "vscode/1.96.2",
  "Editor-Plugin-Version": "copilot-chat/0.26.7",
  "Copilot-Integration-Id": "vscode-chat",
} as const
const AGENT_TEXT = [
  "Summarize the task tool output above and continue with your task.",
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
  "The following tool was executed by the user",
  "Attached image(s) from tool result:",
]
// Add a small safety buffer when polling to avoid hitting the server
// slightly too early due to clock skew / timer drift.
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000 // 3 seconds
function normalizeDomain(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

function getUrls(domain: string) {
  return {
    DEVICE_CODE_URL: `https://${domain}/login/device/code`,
    ACCESS_TOKEN_URL: `https://${domain}/login/oauth/access_token`,
    COPILOT_TOKEN_URL: `https://${domain === "github.com" ? "api.github.com" : `${domain}/api/v3`}/copilot_internal/v2/token`,
  }
}

async function device(url: string, clientID: string, scope: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": `opencode/${Installation.VERSION}`,
    },
    body: JSON.stringify({
      client_id: clientID,
      scope,
    }),
  })

  if (!response.ok) return null

  const data = (await response.json()) as {
    verification_uri: string
    user_code: string
    device_code: string
    interval: number
    expires_in?: number
  }

  if (!data.device_code || !data.user_code || !data.verification_uri) return null
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    interval: data.interval,
    expiresIn: data.expires_in ?? 0,
  }
}

async function poll(
  url: string,
  device: { deviceCode: string; interval: number; expiresIn: number },
  clientID: string,
) {
  while (true) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": `opencode/${Installation.VERSION}`,
      },
      body: JSON.stringify({
        client_id: clientID,
        device_code: device.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    })

    if (!response.ok) return null

    const data = (await response.json()) as {
      access_token?: string
      error?: string
      interval?: number
    }

    if (data.access_token) return data.access_token
    if (data.error === "authorization_pending") {
      await sleep(device.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS)
      continue
    }

    if (data.error === "slow_down") {
      const next =
        typeof data.interval === "number" && data.interval > 0 ? data.interval * 1000 : (device.interval + 5) * 1000
      await sleep(next + OAUTH_POLLING_SAFETY_MARGIN_MS)
      continue
    }

    if (data.error) return null
    await sleep(device.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS)
  }
}

async function service(url: string, token: string) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      ...COPILOT_HEADERS,
      "User-Agent": "GitHubCopilotChat/0.26.7",
      "X-GitHub-Api-Version": "2025-04-01",
    },
  }).catch(() => null)

  if (!response?.ok) return null
  const body = (await response.json().catch(() => null)) as {
    token?: string
    access_token?: string
    refresh_token?: string
    expires_at?: number | string
  } | null
  if (!body) return null

  const access =
    typeof body.token === "string" ? body.token : typeof body.access_token === "string" ? body.access_token : null
  if (!access) return null
  const refresh = typeof body.refresh_token === "string" ? body.refresh_token : access
  const expires =
    typeof body.expires_at === "number"
      ? body.expires_at
      : typeof body.expires_at === "string"
        ? Number.parseInt(body.expires_at, 10) || 0
        : 0
  return { access, refresh, expires }
}

async function exchange(url: string, refresh: string) {
  const token = await service(url, refresh)
  if (!token) return null
  return {
    access: token.access,
    refresh: refresh,
    expires: token.expires ? token.expires * 1000 - 5 * 60 * 1000 : 0,
  }
}

async function usage(url: string, token: string) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      ...COPILOT_HEADERS,
      "User-Agent": "GitHubCopilotChat/0.26.7",
      "X-GitHub-Api-Version": "2025-04-01",
    },
  }).catch(() => null)

  if (!response?.ok) return null
  return token
}

function clientID(client: unknown) {
  return client === "anomaly" ? ANOMALY_CLIENT_ID : COPILOT_CLIENT_ID
}

function configuredClient(config: Awaited<ReturnType<PluginInput["client"]["config"]["get"]>>["data"]) {
  return config?.provider?.["github-copilot"]?.options?.client
}

function agent(body: any) {
  if (body?.messages) {
    const last = body.messages[body.messages.length - 1]
    if (last?.role === "user") {
      if (typeof last.content === "string") return AGENT_TEXT.includes(last.content)
      if (Array.isArray(last.content)) {
        const text = last.content.filter((part: any) => part?.type === "text").map((part: any) => part.text)
        return text.length > 0 && text.every((part: string) => AGENT_TEXT.includes(part))
      }
    }
  }

  if (body?.input) {
    const last = body.input[body.input.length - 1]
    if (last?.role === "user" && Array.isArray(last.content)) {
      const text = last.content.filter((part: any) => part?.type === "input_text").map((part: any) => part.text)
      return text.length > 0 && text.every((part: string) => AGENT_TEXT.includes(part))
    }
  }

  return false
}

export async function CopilotAuthPlugin(input: PluginInput): Promise<Hooks> {
  const sdk = input.client
  return {
    auth: {
      provider: "github-copilot",
      async loader(getAuth, provider) {
        const info = await getAuth()
        if (!info || info.type !== "oauth") return {}

        const enterpriseUrl = info.enterpriseUrl
        const baseURL = enterpriseUrl ? `https://copilot-api.${normalizeDomain(enterpriseUrl)}` : undefined

        if (provider && provider.models) {
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: {
                read: 0,
                write: 0,
              },
            }

            // TODO: re-enable once messages api has higher rate limits
            // TODO: move some of this hacky-ness to models.dev presets once we have better grasp of things here...
            // const base = baseURL ?? model.api.url
            // const claude = model.id.includes("claude")
            // const url = iife(() => {
            //   if (!claude) return base
            //   if (base.endsWith("/v1")) return base
            //   if (base.endsWith("/")) return `${base}v1`
            //   return `${base}/v1`
            // })

            // model.api.url = url
            // model.api.npm = claude ? "@ai-sdk/anthropic" : "@ai-sdk/github-copilot"
            model.api.npm = "@ai-sdk/github-copilot"
          }
        }

        return {
          baseURL,
          apiKey: "",
          async fetch(request: RequestInfo | URL, init?: RequestInit) {
            const info = await getAuth()
            if (info.type !== "oauth") return fetch(request, init)
            const oauth = info as typeof info & { usage?: string }

            const url = request instanceof URL ? request.href : request.toString()
            const hint = iife(() => {
              const headers = new Headers(init?.headers)
              const value = headers.get(INITIATOR)
              headers.delete(INITIATOR)
              init = {
                ...init,
                headers,
              }
              return value
            })
            const { isVision, isAgent } = iife(() => {
              if (hint) {
                return {
                  isVision: false,
                  isAgent: hint === "agent",
                }
              }

              try {
                const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body
                if (agent(body)) return { isVision: false, isAgent: true }

                // Completions API
                if (body?.messages && url.includes("completions")) {
                  const last = body.messages[body.messages.length - 1]
                  return {
                    isVision: body.messages.some(
                      (msg: any) =>
                        Array.isArray(msg.content) && msg.content.some((part: any) => part.type === "image_url"),
                    ),
                    isAgent: last?.role !== "user",
                  }
                }

                // Responses API
                if (body?.input) {
                  const last = body.input[body.input.length - 1]
                  return {
                    isVision: body.input.some(
                      (item: any) =>
                        Array.isArray(item?.content) && item.content.some((part: any) => part.type === "input_image"),
                    ),
                    isAgent: last?.role !== "user",
                  }
                }

                // Messages API
                if (body?.messages) {
                  const last = body.messages[body.messages.length - 1]
                  const hasNonToolCalls =
                    Array.isArray(last?.content) && last.content.some((part: any) => part?.type !== "tool_result")
                  return {
                    isVision: body.messages.some(
                      (item: any) =>
                        Array.isArray(item?.content) &&
                        item.content.some(
                          (part: any) =>
                            part?.type === "image" ||
                            // images can be nested inside tool_result content
                            (part?.type === "tool_result" &&
                              Array.isArray(part?.content) &&
                              part.content.some((nested: any) => nested?.type === "image")),
                        ),
                    ),
                    isAgent: !(last?.role === "user" && hasNonToolCalls),
                  }
                }
              } catch {}
              return { isVision: false, isAgent: false }
            })

            if (!info.access || info.expires < Date.now()) {
              const token = await exchange(
                getUrls(enterpriseUrl ? normalizeDomain(enterpriseUrl) : "github.com").COPILOT_TOKEN_URL,
                info.refresh,
              )
              if (!token) throw new Error("Token refresh failed")

              await input.client.auth.set({
                path: {
                  id: enterpriseUrl ? "github-copilot-enterprise" : "github-copilot",
                },
                body: {
                  type: "oauth",
                  refresh: token.refresh,
                  access: token.access,
                  expires: token.expires,
                  ...(oauth.usage ? { usage: oauth.usage } : {}),
                  ...(enterpriseUrl ? { enterpriseUrl } : {}),
                },
              })

              info.access = token.access
              info.expires = token.expires
            }

            const headers: Record<string, string> = {
              "x-initiator": isAgent ? "agent" : "user",
              ...(init?.headers as Record<string, string>),
              ...COPILOT_HEADERS,
              "User-Agent": "GitHubCopilotChat/0.26.7",
              Authorization: `Bearer ${info.access}`,
              "Openai-Intent": "conversation-edits",
            }

            if (isVision) {
              headers["Copilot-Vision-Request"] = "true"
            }

            delete headers["x-api-key"]
            delete headers["authorization"]

            return fetch(request, {
              ...init,
              headers,
            })
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Login with GitHub Copilot",
          prompts: [
            {
              type: "select",
              key: "deploymentType",
              message: "Select GitHub deployment type",
              options: [
                {
                  label: "GitHub.com",
                  value: "github.com",
                  hint: "Public",
                },
                {
                  label: "GitHub Enterprise",
                  value: "enterprise",
                  hint: "Data residency or self-hosted",
                },
              ],
            },
            {
              type: "text",
              key: "enterpriseUrl",
              message: "Enter your GitHub Enterprise URL or domain",
              placeholder: "company.ghe.com or https://company.ghe.com",
              condition: (inputs) => inputs.deploymentType === "enterprise",
              validate: (value) => {
                if (!value) return "URL or domain is required"
                try {
                  const url = value.includes("://") ? new URL(value) : new URL(`https://${value}`)
                  if (!url.hostname) return "Please enter a valid URL or domain"
                  return undefined
                } catch {
                  return "Please enter a valid URL (e.g., company.ghe.com or https://company.ghe.com)"
                }
              },
            },
          ],
          async authorize(inputs = {}) {
            const deploymentType = inputs.deploymentType || "github.com"
            const cfg = await input.client.config.get().then((result) => result.data)

            let domain = "github.com"
            let actualProvider = "github-copilot"

            if (deploymentType === "enterprise") {
              const enterpriseUrl = inputs.enterpriseUrl
              domain = normalizeDomain(enterpriseUrl!)
              actualProvider = "github-copilot-enterprise"
            }

            const urls = getUrls(domain)
            const selected = clientID(configuredClient(cfg))
            const anomaly = selected === ANOMALY_CLIENT_ID

            const deviceData = await device(urls.DEVICE_CODE_URL, selected, OAUTH_SCOPE)
            if (!deviceData) throw new Error("Failed to initiate device authorization")
            const usageData = anomaly
              ? await device(urls.DEVICE_CODE_URL, COPILOT_CLIENT_ID, OAUTH_SCOPE).catch(() => null)
              : null

            return {
              url: deviceData.verificationUri,
              instructions: usageData
                ? [
                    `Enter code: ${deviceData.userCode}`,
                    "",
                    "To enable usage tracking, also complete:",
                    `Go to: ${usageData.verificationUri}`,
                    `Enter code: ${usageData.userCode}`,
                  ].join("\n")
                : `Enter code: ${deviceData.userCode}`,
              method: "auto" as const,
              async callback() {
                let usage: string | null = null
                const usagePromise = usageData
                  ? poll(urls.ACCESS_TOKEN_URL, usageData, COPILOT_CLIENT_ID)
                      .then((value) => {
                        usage = value
                        return value
                      })
                      .catch(() => null)
                  : Promise.resolve(null)

                const deviceToken = await poll(urls.ACCESS_TOKEN_URL, deviceData, selected)
                if (!deviceToken) return { type: "failed" as const }

                const result: {
                  type: "success"
                  refresh: string
                  access: string
                  expires: number
                  usage?: string
                  provider?: string
                  enterpriseUrl?: string
                } = {
                  type: "success",
                  refresh: deviceToken,
                  access: "",
                  expires: 0,
                  ...(usage ? { usage } : {}),
                }

                void usagePromise
                  .then(async (value) => {
                    if (!value || result.usage === value) return
                    await input.client.auth.set({
                      path: {
                        id: actualProvider,
                      },
                      body: {
                        type: "oauth",
                        refresh: result.refresh,
                        access: result.access,
                        expires: result.expires,
                        ...(value ? { usage: value } : {}),
                        ...(actualProvider === "github-copilot-enterprise" ? { enterpriseUrl: domain } : {}),
                      },
                    })
                  })
                  .catch(() => null)

                if (actualProvider === "github-copilot-enterprise") {
                  result.provider = "github-copilot-enterprise"
                  result.enterpriseUrl = domain
                }

                return result
              },
            }
          },
        },
      ],
    },
    "chat.headers": async (incoming, output) => {
      if (!incoming.model.providerID.includes("github-copilot")) return

      if (incoming.model.api.npm === "@ai-sdk/anthropic") {
        output.headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
      }

      const parts = await sdk.session
        .message({
          path: {
            id: incoming.message.sessionID,
            messageID: incoming.message.id,
          },
          query: {
            directory: input.directory,
          },
          throwOnError: true,
        })
        .catch(() => undefined)

      if (parts?.data.parts?.some((part) => part.type === "compaction")) {
        output.headers["x-initiator"] = "agent"
        return
      }

      const synthetic = parts?.data.parts.some((part) => {
        if (part.type === "subtask") return true
        if (part.type !== "text" || !part.synthetic) return false
        return AGENT_TEXT.includes(part.text)
      })

      const session = await sdk.session
        .get({
          path: {
            id: incoming.sessionID,
          },
          query: {
            directory: input.directory,
          },
          throwOnError: true,
        })
        .catch(() => undefined)

      if (session?.data.parentID || synthetic) {
        if (incoming.model.api.npm === "@ai-sdk/github-copilot") {
          output.headers[INITIATOR] = "agent"
          return
        }

        output.headers["x-initiator"] = "agent"
        return
      }

      // Skip x-initiator override when using @ai-sdk/github-copilot - it has its own
      // fetch wrapper that sets x-initiator based on message content, and overriding
      // it here causes "invalid initiator" validation errors from Copilot API
      if (incoming.model.api.npm === "@ai-sdk/github-copilot") return
    },
  }
}
