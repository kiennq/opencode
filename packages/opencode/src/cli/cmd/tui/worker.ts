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

const BASE_URL = "http://opencode.internal"

function errmsg(e: unknown) {
  return e instanceof Error ? e.message : e
}

async function appFetch(input: RequestInfo | URL, init?: RequestInit) {
  const request = new Request(input, init)
  const password = Flag.OPENCODE_SERVER_PASSWORD
  if (password) {
    request.headers.set("Authorization", `Basic ${btoa(`${Flag.OPENCODE_SERVER_USERNAME ?? "opencode"}:${password}`)}`)
  }
  return await Server.App().fetch(request)
}

function provide<T>(directory: string, fn: () => T) {
  return Instance.provide({ directory, init: InstanceBootstrap, fn })
}

function startEventStream(directory: string) {
  const compacted = new Set<string>()

  const sdk = createOpencodeClient({
    baseUrl: BASE_URL,
    directory,
    fetch: appFetch as typeof globalThis.fetch,
  })

  async function resume(sessionID: string, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
      Log.Default.info("resuming session after compaction", { sessionID, attempt })
      const ok = await appFetch(`${BASE_URL}/session/${sessionID}/resume`, { method: "POST" })
        .then(() => true)
        .catch((e: unknown) => {
          Log.Default.error("failed to resume session after compaction", { sessionID, attempt, error: errmsg(e) })
          return false
        })
      if (ok) return true
      if (attempt < retries - 1) await Bun.sleep(500 * (attempt + 1))
    }
    Log.Default.error("exhausted resume retries", { sessionID })
    return false
  }

  async function resumeAndClear(sessionID: string) {
    if (!(await resume(sessionID))) return
    await provide(directory, () => Session.setCompacting({ sessionID, time: undefined })).catch((e: unknown) => {
      Log.Default.error("failed to clear compacting marker", { sessionID, error: errmsg(e) })
    })
  }

  // Check for pending resumes on startup (crash recovery)
  setTimeout(() => {
    provide(directory, () => Session.pendingResume())
      .then((pending) => {
        for (const sessionID of pending) {
          Log.Default.info("found pending resume session from DB on startup", { sessionID })
          resumeAndClear(sessionID)
        }
      })
      .catch((e: unknown) => {
        Log.Default.error("failed to check pending resume on startup", { error: errmsg(e) })
      })
  }, 1000)
  ;(async () => {
    let backoff = 250
    while (true) {
      const events = await Promise.resolve(sdk.event.subscribe({})).catch(() => undefined)
      if (!events) {
        await Bun.sleep(backoff)
        backoff = Math.min(backoff * 1.5, 30000)
        continue
      }
      backoff = 250

      for await (const event of events.stream) {
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
              provide(directory, () => Session.pendingResume())
                .then((pending) => {
                  if (pending.includes(props.sessionID)) {
                    Log.Default.info("compacted session idle (DB fallback), resuming", {
                      sessionID: props.sessionID,
                    })
                    resumeAndClear(props.sessionID)
                  }
                })
                .catch((e: unknown) => {
                  Log.Default.error("failed to check pending resume on idle", {
                    sessionID: props.sessionID,
                    error: errmsg(e),
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
    Log.Default.error("event stream error", { error: errmsg(error) })
  })
}

const rpc = {
  async fetch(input: { url: string; init: RequestInit & { headers: Record<string, string> } }) {
    const url = input.url.startsWith("http") ? input.url : `${BASE_URL}${input.url}`
    const response = await Server.App().fetch(new Request(url, input.init))
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
      return Server.listen({
        port: input.port ?? 0,
        hostname: input.hostname ?? "127.0.0.1",
        mdns: input.mdns ?? false,
      }).url.toString()
    }
    return undefined
  },
  async checkUpgrade(input: { directory: string }) {
    return provide(input.directory, async () => {
      await upgrade().catch(() => {})
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
