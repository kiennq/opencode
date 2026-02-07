import { cmd } from "@/cli/cmd/cmd"
import { tui } from "./app"
import { Rpc } from "@/util/rpc"
import { type rpc } from "./worker"
import path from "path"
import { UI } from "@/cli/ui"
import { iife } from "@/util/iife"
import { Log } from "@/util/log"
import { withNetworkOptions, resolveNetworkOptions } from "@/cli/network"
import type { Event } from "@opencode-ai/sdk/v2"
import type { EventSource } from "./context/sdk"

type RpcClient = ReturnType<typeof Rpc.client<typeof rpc>>

const MEMORY_CHECK_INTERVAL = 60_000
const MEMORY_RECYCLE_THRESHOLD_DEFAULT = 4096

// Build the args to re-launch the process as a worker.
// Compiled binary: [binary, ...execArgv] — the binary IS the entrypoint.
// Dev mode: [bun, ...execArgv, scriptPath] — need the script path explicitly.
// Compiled binaries use bunfs paths (B:/~BUN/ or /$bunfs/) which we skip.
const script = process.argv[1]
const dev = script && /\.[cm]?[jt]sx?$/.test(script) && !script.includes("~BUN") && !script.includes("$bunfs")
const args = dev ? [process.execPath, ...process.execArgv, script] : [process.execPath, ...process.execArgv]

interface WorkerManager {
  client: RpcClient
  shutdown: () => Promise<void>
}

function createWorkerManager(env: Record<string, string>, onCrash?: (code: number | null) => void): WorkerManager {
  const log = Log.create({ service: "worker" })
  log.info("spawning worker", { parent: process.pid, args: args.join(" "), dev })
  const bridge = Rpc.ipc()
  const proc = Bun.spawn(args, {
    env: { ...env, OPENCODE_WORKER_MODE: "1" },
    stdio: ["ignore", "inherit", "inherit"],
    serialization: "json",
    ipc(msg) {
      bridge.dispatch(msg)
    },
  })
  const transport = bridge.transport((msg) => proc.send(msg))
  log.info("worker spawned", { parent: process.pid, child: proc.pid })
  let stopped = false
  const client = Rpc.client<typeof rpc>(transport)
  proc.exited.then((code) => {
    log.info("worker exited", { parent: process.pid, child: proc.pid, code, stopped })
    if (!stopped) {
      client.invalidate()
      onCrash?.(code)
    }
  })
  return {
    client,
    async shutdown() {
      stopped = true
      log.info("worker shutdown requested", { parent: process.pid, child: proc.pid })
      try {
        await client.call("shutdown", undefined)
      } catch {
        /* Ignore */
      }
      client.invalidate()
      proc.kill()
      log.info("worker killed", { parent: process.pid, child: proc.pid })
    },
  }
}

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
    if (args.fork && !args.continue && !args.session) {
      UI.error("--fork requires --continue or --session")
      process.exit(1)
    }
    const baseCwd = process.env.PWD ?? process.cwd()
    const cwd = args.project ? path.resolve(baseCwd, args.project) : process.cwd()
    try {
      process.chdir(cwd)
    } catch {
      UI.error("Failed to change directory to " + cwd)
      return
    }
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    )
    let pool: WorkerManager = undefined!

    process.on("uncaughtException", (e) => {
      Log.Default.error(e)
    })
    process.on("unhandledRejection", (e) => {
      Log.Default.error(e)
    })
    process.on("SIGUSR2", async () => {
      await pool.client.call("reload", undefined)
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

    // --- Worker recycling infrastructure ---
    const handlers = new Set<(event: Event) => void>()
    const busy = new Set<string>()
    const compacted = new Set<string>()
    let recycling: Promise<void> | undefined
    let stale = false
    let exiting = false

    function onCrash(code: number | null) {
      if (exiting) return
      Log.Default.info("worker crashed, respawning", { parent: process.pid, code })
      busy.clear()
      compacted.clear()
      stale = false
      if (!recycling)
        recycling = respawn().finally(() => {
          recycling = undefined
        })
    }

    function wire() {
      pool.client.on<Event>("event", (event) => {
        if (event.type === "session.compacted") {
          const props = event.properties as { sessionID: string }
          compacted.add(props.sessionID)
          Log.Default.info("session compacted", { parent: process.pid, sessionID: props.sessionID })
        }
        if (event.type === "session.status") {
          const props = event.properties as { sessionID: string; status: { type: string } }
          if (props.status.type === "idle") {
            busy.delete(props.sessionID)
            if (compacted.delete(props.sessionID)) {
              Log.Default.info("compacted session idle, recycling", {
                parent: process.pid,
                sessionID: props.sessionID,
              })
              if (!recycling)
                recycling = recycleAndResume(props.sessionID).finally(() => {
                  recycling = undefined
                })
            }
          } else busy.add(props.sessionID)
        }
        for (const handler of handlers) handler(event)
      })
    }

    async function respawn() {
      Log.Default.info("respawning worker", { parent: process.pid })
      pool = createWorkerManager(env, onCrash)
      wire()
      if (shouldStartServer) {
        await pool.client.call("server", networkOpts)
      }
      stale = false
      Log.Default.info("respawn complete", { parent: process.pid })
    }

    async function recycle() {
      if (busy.size > 0) {
        Log.Default.info("recycle deferred", { parent: process.pid, busy: busy.size })
        return
      }
      Log.Default.info("recycling worker", { parent: process.pid, reason: "memory threshold exceeded" })
      await pool.shutdown()
      await respawn()
      Log.Default.info("recycle complete", { parent: process.pid })
    }

    async function recycleAndResume(sessionID: string) {
      Log.Default.info("recycling worker after compaction", { parent: process.pid, sessionID })
      await pool.shutdown()
      await respawn()
      Log.Default.info("resuming session in new worker", { parent: process.pid, sessionID })
      pool.client
        .call("fetch", {
          url: `http://opencode.internal/session/${sessionID}/resume`,
          method: "POST",
          headers: { "content-type": "application/json" },
        })
        .catch((e: unknown) => {
          Log.Default.error("failed to resume session after recycle", {
            parent: process.pid,
            sessionID,
            error: e instanceof Error ? e.message : e,
          })
        })
    }

    // Initial worker spawn
    pool = createWorkerManager(env, onCrash)
    wire()

    const recycleFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (stale && busy.size === 0) {
        Log.Default.info("recycleFetch triggering recycle", { parent: process.pid })
        if (!recycling)
          recycling = recycle().finally(() => {
            recycling = undefined
          })
        await recycling
      }
      const request = new Request(input, init)
      const body = request.body ? await request.text() : undefined
      const result = await pool.client.call("fetch", {
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        body,
      })
      return new Response(result.body, { status: result.status, headers: result.headers })
    }) as typeof fetch

    const stableEvents: EventSource = {
      on: (handler) => {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
    }

    let url: string
    let customFetch: typeof fetch | undefined
    let events: EventSource | undefined

    if (shouldStartServer) {
      const server = await pool.client.call("server", networkOpts)
      url = server.url
    } else {
      url = "http://opencode.internal"
      customFetch = recycleFetch
      events = stableEvents
    }

    const monitor = setInterval(async () => {
      try {
        const mem = await pool.client.call("memory", undefined)
        const config = await pool.client.call("config", undefined)
        const thresholdMB = config.memory_threshold ?? MEMORY_RECYCLE_THRESHOLD_DEFAULT
        const threshold = thresholdMB * 1024 * 1024
        const was = stale
        if (mem.rss > threshold) stale = true
        const rssMB = (mem.rss / 1024 / 1024).toFixed(0)
        const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(0)
        Log.Default.info("worker memory", {
          parent: process.pid,
          rss: rssMB + " MB",
          heap: heapMB + " MB",
          threshold: thresholdMB + " MB",
          stale,
          busy: busy.size,
        })
        if (!was && stale)
          Log.Default.info("worker marked stale", {
            parent: process.pid,
            rss: rssMB + " MB",
            threshold: thresholdMB + " MB",
          })
        if (stale && busy.size === 0) {
          Log.Default.info("monitor triggering recycle", { parent: process.pid })
          if (!recycling)
            recycling = recycle().finally(() => {
              recycling = undefined
            })
          await recycling
        }
      } catch (e) {
        Log.Default.error("worker memory check failed", { error: e instanceof Error ? e.message : e })
      }
    }, MEMORY_CHECK_INTERVAL)

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
        clearInterval(monitor)
        await pool.shutdown()
      },
    })

    setTimeout(() => {
      pool.client.call("checkUpgrade", { directory: cwd }).catch(() => {})
    }, 1000)
    await tuiPromise
  },
})
