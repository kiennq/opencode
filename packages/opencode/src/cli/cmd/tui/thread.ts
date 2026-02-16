import { cmd } from "@/cli/cmd/cmd"
import { tui } from "./app"
import path from "path"
import { UI } from "@/cli/ui"
import { iife } from "@/util/iife"
import { Log } from "@/util/log"
import { withNetworkOptions, resolveNetworkOptions } from "@/cli/network"
import type { Event } from "@opencode-ai/sdk/v2"
import type { EventSource } from "./context/sdk"
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "./win32"
import { Installation } from "@/installation"
import { Server } from "@/server/server"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Session } from "@/session"
import { Flag } from "@/flag/flag"
import type { BunWebSocketData } from "hono/bun"

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: "start opencode tui",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", { type: "string", describe: "path to start opencode in" })
      .option("model", { type: "string", alias: ["m"], describe: "model to use in the format of provider/model" })
      .option("continue", { alias: ["c"], describe: "continue the last session", type: "boolean" })
      .option("session", { alias: ["s"], type: "string", describe: "session id to continue" })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("prompt", { type: "string", describe: "prompt to use" })
      .option("agent", { type: "string", describe: "agent to use" }),
  handler: async (args) => {
    // Keep ENABLE_PROCESSED_INPUT cleared even if other code flips it.
    // (Important when running under `bun run` wrappers on Windows.)
    const unguard = win32InstallCtrlCGuard()
    try {
      // Must be the very first thing — disables CTRL_C_EVENT before any async work
      // so the OS cannot kill the process group.
      win32DisableProcessedInput()

      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }
      const baseCwd = process.env.PWD ?? process.cwd()
      const cwd = args.project ? path.resolve(baseCwd, args.project) : process.cwd()
      try {
        process.chdir(cwd)
      } catch {
        UI.error("Failed to change directory to " + cwd)
        return
      }

      // Initialize logging
      await Log.init({
        print: process.argv.includes("--print-logs"),
        dev: Installation.isLocal(),
        level: Installation.isLocal() ? "DEBUG" : "INFO",
      })

      Log.Default.info("opencode starting", { pid: process.pid })

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

      const prompt = await iife(async () => {
        const piped = !process.stdin.isTTY ? await Bun.stdin.text() : undefined
        if (!args.prompt) return piped
        return piped ? piped + "\n" + args.prompt : args.prompt
      })

      const networkOpts = await resolveNetworkOptions(args)
      const shouldStartServer =
        process.argv.includes("--port") ||
        process.argv.includes("--hostname") ||
        process.argv.includes("--mdns") ||
        networkOpts.mdns ||
        networkOpts.port !== 0 ||
        networkOpts.hostname !== "127.0.0.1"

      // --- Event handling infrastructure ---
      const handlers = new Set<(event: Event) => void>()
      const compacted = new Set<string>()
      let exiting = false
      let server: Bun.Server<BunWebSocketData> | undefined

      // Helper to get authorization header
      function getAuthorizationHeader(): string | undefined {
        const password = Flag.OPENCODE_SERVER_PASSWORD
        if (!password) return undefined
        const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
        return `Basic ${btoa(`${username}:${password}`)}`
      }

      // Resume a session after compaction
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

      // Clear compacting marker after successful resume
      async function resumeAndClear(sessionID: string) {
        const ok = await resumeSession(sessionID)
        if (ok) {
          await Instance.provide({
            directory: cwd,
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

      // Set up event stream to listen for compaction events
      const eventStream = { abort: undefined as AbortController | undefined }

      function startEventStream() {
        if (eventStream.abort) eventStream.abort.abort()
        const abort = new AbortController()
        eventStream.abort = abort
        const signal = abort.signal

        const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init)
          const auth = getAuthorizationHeader()
          if (auth) request.headers.set("Authorization", auth)
          return Server.App().fetch(request)
        }) as typeof globalThis.fetch

        const sdk = createOpencodeClient({
          baseUrl: "http://opencode.internal",
          directory: cwd,
          fetch: fetchFn,
          signal,
        })

        ;(async () => {
          let backoff = 250
          const maxBackoff = 30000
          const backoffMultiplier = 1.5

          while (!signal.aborted) {
            const events = await Promise.resolve(sdk.event.subscribe({}, { signal })).catch(() => undefined)

            if (!events) {
              await Bun.sleep(backoff)
              backoff = Math.min(backoff * backoffMultiplier, maxBackoff)
              continue
            }

            backoff = 250

            for await (const event of events.stream) {
              const e = event as Event

              // Handle compaction events - auto-resume without worker restart
              if (e.type === "session.compacted") {
                const props = e.properties as { sessionID: string }
                compacted.add(props.sessionID)
                Log.Default.info("session compacted", { sessionID: props.sessionID })
              }

              if (e.type === "session.status") {
                const props = e.properties as { sessionID: string; status: { type: string } }
                if (props.status.type === "idle") {
                  if (compacted.delete(props.sessionID)) {
                    Log.Default.info("compacted session idle, resuming", { sessionID: props.sessionID })
                    // Resume without worker restart - just call resume endpoint
                    resumeAndClear(props.sessionID)
                  } else {
                    // Race condition: session.status may arrive before session.compacted.
                    // Check DB for time_compacting marker to catch this case.
                    Instance.provide({
                      directory: cwd,
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

              // Forward events to TUI handlers
              for (const handler of handlers) handler(e)
            }

            if (!signal.aborted) {
              await Bun.sleep(250)
            }
          }
        })().catch((error) => {
          Log.Default.error("event stream error", {
            error: error instanceof Error ? error.message : error,
          })
        })
      }

      // Direct fetch implementation (no worker RPC)
      const directFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = new Request(input, init)
        const auth = getAuthorizationHeader()
        if (auth && !request.headers.has("Authorization")) {
          request.headers.set("Authorization", auth)
        }
        return Server.App().fetch(request)
      }) as typeof fetch

      const stableEvents: EventSource = {
        on: (handler) => {
          handlers.add(handler)
          return () => {
            handlers.delete(handler)
          }
        },
      }

      // Start the event stream
      startEventStream()

      // Check for any sessions that need resume on startup (crash recovery)
      setTimeout(async () => {
        try {
          const pending = await Instance.provide({
            directory: cwd,
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

      let url: string
      let customFetch: typeof fetch | undefined
      let events: EventSource | undefined

      if (shouldStartServer) {
        server = Server.listen(networkOpts)
        url = server.url.toString()
      } else {
        url = "http://opencode.internal"
        customFetch = directFetch
        events = stableEvents
      }

      const tuiPromise = tui({
        url,
        fetch: customFetch,
        events,
        args: {
          continue: args.continue,
          sessionID: args.session,
          agent: args.agent,
          model: args.model,
          prompt,
          fork: args.fork,
        },
        onExit: async () => {
          exiting = true
          if (eventStream.abort) eventStream.abort.abort()
          await Instance.disposeAll()
          if (server) server.stop(true)
        },
      })

      // Check for upgrades in background
      setTimeout(() => {
        Instance.provide({
          directory: cwd,
          init: InstanceBootstrap,
          fn: async () => {
            await upgrade().catch(() => {})
          },
        }).catch(() => {})
      }, 1000)

      await tuiPromise
    } finally {
      unguard?.()
    }
  },
})
