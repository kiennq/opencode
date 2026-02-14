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
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "./win32"

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
      // Kill the entire process tree to prevent orphaned child processes
      // (e.g. plugins that spawn `opencode --version` via execSync)
      if (process.platform === "win32") {
        Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(proc.pid)], {
          stdio: ["ignore", "ignore", "ignore"],
        })
      } else {
        proc.kill()
      }
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
    // Keep ENABLE_PROCESSED_INPUT cleared even if other code flips it.
    // (Important when running under `bun run` wrappers on Windows.)
    const unguard = win32InstallCtrlCGuard()
    try {
      // Must be the very first thing — disables CTRL_C_EVENT before any Worker
      // spawn or async work so the OS cannot kill the process group.
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
      let prelaunching: Promise<void> | undefined
      let successor: WorkerManager | undefined
      let stale = false
      let exiting = false

      function onWorkerCrash(worker: WorkerManager, code: number | null) {
        if (exiting) return
        if (worker === pool) {
          Log.Default.info("active worker crashed, respawning", { parent: process.pid, code })
          // Resume both compacted sessions and any that were busy at crash time.
          // Busy sessions may have had a synthetic continue message written to DB
          // (e.g., during compaction) before the session.compacted event reached us.
          const pending = new Set([...compacted, ...busy])
          busy.clear()
          compacted.clear()
          stale = false
          prelaunching = undefined
          if (!recycling)
            recycling = respawn()
              .then(async () => {
                // Query DB for sessions that were compacting but never resumed.
                // This handles the edge case where the worker crashed before the
                // session.compacted event reached the parent process.
                const dbPending = await pool.client.call("pendingResume", { directory: cwd }).catch((e: unknown) => {
                  Log.Default.error("failed to query pending resume sessions", {
                    parent: process.pid,
                    error: e instanceof Error ? e.message : e,
                  })
                  return [] as string[]
                })
                for (const sessionID of dbPending) {
                  if (!pending.has(sessionID)) {
                    Log.Default.info("found pending resume session from DB", { parent: process.pid, sessionID })
                    pending.add(sessionID)
                  }
                }
                for (const sessionID of pending) resumeAndClear(sessionID)
              })
              .finally(() => {
                recycling = undefined
              })
          return
        }
        if (worker === successor) {
          Log.Default.info("successor worker crashed, discarding", { parent: process.pid, code })
          successor = undefined
          prelaunching = undefined
        }
      }

      async function prelaunch() {
        if (successor || exiting) return
        Log.Default.info("pre-launching successor worker", { parent: process.pid })
        const next = createWorkerManager(env, (code) => onWorkerCrash(next, code))
        if (shouldStartServer) {
          await next.client.call("server", networkOpts)
        }
        if (exiting) {
          await next.shutdown()
          return
        }
        successor = next
        Log.Default.info("successor worker ready", { parent: process.pid })
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
        if (successor) {
          Log.Default.info("using pre-launched successor", { parent: process.pid })
          pool = successor
          successor = undefined
        } else {
          const fresh = createWorkerManager(env, (code) => onWorkerCrash(fresh, code))
          pool = fresh
          if (shouldStartServer) {
            await pool.client.call("server", networkOpts)
          }
        }
        wire()
        stale = false
        prelaunching = undefined
        // Notify TUI that the instance was recycled so it re-bootstraps (re-syncs messages, config, etc.)
        for (const handler of handlers) handler({ type: "server.instance.disposed", properties: { directory: cwd } })
        Log.Default.info("respawn complete", { parent: process.pid })
      }

      async function resume(sessionID: string, retries = 3) {
        for (let attempt = 0; attempt < retries; attempt++) {
          Log.Default.info("resuming session in new worker", { parent: process.pid, sessionID, attempt })
          const ok = await pool.client
            .call("fetch", {
              url: `http://opencode.internal/session/${sessionID}/resume`,
              method: "POST",
              headers: { "content-type": "application/json" },
            })
            .then(() => true)
            .catch((e: unknown) => {
              Log.Default.error("failed to resume session after recycle", {
                parent: process.pid,
                sessionID,
                attempt,
                error: e instanceof Error ? e.message : e,
              })
              return false
            })
          if (ok) return true
          if (attempt < retries - 1) await Bun.sleep(500 * (attempt + 1))
        }
        Log.Default.error("exhausted resume retries", { parent: process.pid, sessionID })
        return false
      }

      async function resumeAndClear(sessionID: string) {
        const ok = await resume(sessionID)
        if (ok) {
          // Clear the time_compacting marker now that session has resumed
          await pool.client.call("clearCompacting", { directory: cwd, sessionID }).catch((e: unknown) => {
            Log.Default.error("failed to clear compacting marker", {
              parent: process.pid,
              sessionID,
              error: e instanceof Error ? e.message : e,
            })
          })
        }
      }

      async function recycle() {
        if (busy.size > 0) {
          Log.Default.info("recycle deferred", { parent: process.pid, busy: busy.size })
          return
        }
        Log.Default.info("recycling worker", { parent: process.pid, reason: "memory threshold exceeded" })
        if (prelaunching) await prelaunching
        await pool.shutdown()
        await respawn()
        Log.Default.info("recycle complete", { parent: process.pid })
      }

      async function recycleAndResume(sessionID: string) {
        Log.Default.info("recycling worker after compaction", { parent: process.pid, sessionID })
        if (prelaunching) await prelaunching
        await pool.shutdown()
        await respawn()
        await resumeAndClear(sessionID)
      }

      // Initial worker spawn
      const initial = createWorkerManager(env, (code) => onWorkerCrash(initial, code))
      pool = initial
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
          if (!was && stale) {
            Log.Default.info("worker marked stale", {
              parent: process.pid,
              rss: rssMB + " MB",
              threshold: thresholdMB + " MB",
            })
            if (!prelaunching)
              prelaunching = prelaunch().catch((e) => {
                Log.Default.error("prelaunch failed", { error: e instanceof Error ? e.message : e })
                prelaunching = undefined
              })
          }
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
          await Promise.all([pool.shutdown(), successor?.shutdown()])
        },
      })

      setTimeout(() => {
        pool.client.call("checkUpgrade", { directory: cwd }).catch(() => {})
      }, 1000)
      await tuiPromise
    } finally {
      unguard?.()
    }
  },
})
