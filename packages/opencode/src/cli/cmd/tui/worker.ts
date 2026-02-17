import { Server } from "@/server/server"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Log } from "@/util/log"
import { Rpc } from "@/util/rpc"
import { Installation } from "@/installation"
import { Config } from "@/config/config"
import { Session } from "@/session"
import { Flag } from "@/flag/flag"
import { upgrade } from "@/cli/upgrade"
import { GlobalBus } from "@/bus/global"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { BunWebSocketData } from "hono/bun"

await Log.init({
  print: process.argv.includes("--print-logs"),
  dev: Installation.isLocal(),
  level: Installation.isLocal() ? "DEBUG" : "INFO",
})

process.on("uncaughtException", (e) => {
  Log.Default.error(e)
})
process.on("unhandledRejection", (e) => {
  Log.Default.error(e)
})
process.on("SIGUSR2", async () => {
  Config.global.reset()
  await Instance.disposeAll()
})

const transport = Rpc.self()

GlobalBus.on("event", (data) => {
  Rpc.emit("global.event", data, transport)
})

function getAuthorizationHeader(): string | undefined {
  const password = Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined
  const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  return `Basic ${btoa(`${username}:${password}`)}`
}

function startEventStream(directory: string) {
  const compacted = new Set<string>()
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const auth = getAuthorizationHeader()
    if (auth) request.headers.set("Authorization", auth)
    return Server.App().fetch(request)
  }) as typeof globalThis.fetch

  const sdk = createOpencodeClient({
    baseUrl: "http://opencode.internal",
    directory,
    fetch: fetchFn,
  })

  async function resumeSession(sessionID: string, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
      Log.Default.info("resuming session after compaction", { sessionID, attempt })
      const headers: Record<string, string> = { "content-type": "application/json" }
      const auth = getAuthorizationHeader()
      if (auth) headers["Authorization"] = auth
      const request = new Request(`http://opencode.internal/session/${sessionID}/resume`, {
        method: "POST",
        headers,
      })
      const ok = await Promise.resolve(Server.App().fetch(request))
        .then(() => true)
        .catch((e: unknown) => {
          Log.Default.error("failed to resume session after compaction", {
            sessionID,
            attempt,
            error: e instanceof Error ? e.message : e,
          })
          return false
        })
      if (ok) return true
      if (attempt < retries - 1) await Bun.sleep(500 * (attempt + 1))
    }
    Log.Default.error("exhausted resume retries", { sessionID })
    return false
  }

  async function resumeAndClear(sessionID: string) {
    const ok = await resumeSession(sessionID)
    if (ok) {
      await Instance.provide({
        directory,
        init: InstanceBootstrap,
        fn: () => Session.setCompacting({ sessionID, time: undefined }),
      }).catch((e: unknown) => {
        Log.Default.error("failed to clear compacting marker", {
          sessionID,
          error: e instanceof Error ? e.message : e,
        })
      })
    }
  }

  // Check for pending resumes on startup (crash recovery)
  setTimeout(async () => {
    try {
      const pending = await Instance.provide({
        directory,
        init: InstanceBootstrap,
        fn: () => Session.pendingResume(),
      })
      for (const sessionID of pending) {
        Log.Default.info("found pending resume session from DB on startup", { sessionID })
        resumeAndClear(sessionID)
      }
    } catch (e) {
      Log.Default.error("failed to check pending resume on startup", {
        error: e instanceof Error ? e.message : e,
      })
    }
  }, 1000)
  ;(async () => {
    let backoff = 250
    const maxBackoff = 30000
    const backoffMultiplier = 1.5

    while (true) {
      const events = await Promise.resolve(sdk.event.subscribe({})).catch(() => undefined)

      if (!events) {
        await Bun.sleep(backoff)
        backoff = Math.min(backoff * backoffMultiplier, maxBackoff)
        continue
      }

      backoff = 250

      for await (const event of events.stream) {
        // Handle compaction events
        if (event.type === "session.compacted") {
          const props = event.properties as { sessionID: string }
          compacted.add(props.sessionID)
          Log.Default.info("session compacted", { sessionID: props.sessionID })
        }

        if (event.type === "session.status") {
          const props = event.properties as { sessionID: string; status: { type: string } }
          if (props.status.type === "idle") {
            if (compacted.delete(props.sessionID)) {
              Log.Default.info("compacted session idle, resuming", { sessionID: props.sessionID })
              resumeAndClear(props.sessionID)
            } else {
              Instance.provide({
                directory,
                init: InstanceBootstrap,
                fn: () => Session.pendingResume(),
              })
                .then((pending) => {
                  if (Array.isArray(pending) && pending.includes(props.sessionID)) {
                    Log.Default.info("compacted session idle (DB fallback), resuming", {
                      sessionID: props.sessionID,
                    })
                    resumeAndClear(props.sessionID)
                  }
                })
                .catch((e: unknown) => {
                  Log.Default.error("failed to check pending resume on idle", {
                    sessionID: props.sessionID,
                    error: e instanceof Error ? e.message : e,
                  })
                })
            }
          }
        }

        Rpc.emit("event", event, transport)
      }

      await Bun.sleep(250)
    }
  })().catch((error) => {
    Log.Default.error("event stream error", {
      error: error instanceof Error ? error.message : error,
    })
  })
}

const rpc = {
  async fetch(input: { url: string; init: RequestInit & { headers: Record<string, string> } }) {
    const url = input.url.startsWith("http") ? input.url : `http://opencode.internal${input.url}`
    const request = new Request(url, input.init)
    const response = await Server.App().fetch(request)
    return {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
    }
  },
  async server(input: {
    directory: string
    port?: number
    hostname?: string
    mdns?: boolean
  }): Promise<string | undefined> {
    startEventStream(input.directory)
    if (input.port || input.hostname || input.mdns) {
      const server = Server.listen({
        port: input.port ?? 0,
        hostname: input.hostname ?? "127.0.0.1",
        mdns: input.mdns ?? false,
      })
      return server.url.toString()
    }
    return undefined
  },
  async checkUpgrade(input: { directory: string }) {
    return Instance.provide({
      directory: input.directory,
      init: InstanceBootstrap,
      fn: async () => {
        await upgrade().catch(() => {})
      },
    }).catch(() => {})
  },
  async reload(_input: {}) {
    Config.global.reset()
    await Instance.disposeAll()
  },
  async shutdown(_input: {}) {
    await Instance.disposeAll()
  },
}

export type WorkerRpc = typeof rpc

Rpc.listen(rpc, transport)
