import { cmd } from "@/cli/cmd/cmd"
import { tui } from "./app"
import { Rpc } from "@/util/rpc"
import { type rpc } from "./worker"
import path from "node:path"
import { UI } from "@/cli/ui"
import { iife } from "@/util/iife"
import { Log } from "@/util/log"
import { withNetworkOptions, resolveNetworkOptions } from "@/cli/network"
import type { Event } from "@opencode-ai/sdk/v2"
import type { EventSource } from "./context/sdk"
import { File, Util } from "@opencode-ai/runtime"

declare global {
  const OPENCODE_WORKER_PATH: string
}

type RpcClient = ReturnType<typeof Rpc.client<typeof rpc>>

// Memory check interval (60 seconds)
const MEMORY_CHECK_INTERVAL = 60_000

interface WorkerManager {
  client: RpcClient
  worker: Worker
  shutdown: () => Promise<void>
}

function createWorkerManager(workerPath: string | URL, env: Record<string, string>): WorkerManager {
  const log = Log.create({ service: "worker" })

  const worker = new Worker(workerPath, { env })
  worker.onerror = (e) => log.error("worker error", { error: e })
  const client = Rpc.client<typeof rpc>(worker)

  return {
    client,
    worker,
    async shutdown() {
      try {
        await client.call("shutdown", undefined)
      } catch {
        // Ignore
      }
      client.invalidate()
      worker.terminate()
    },
  }
}

function createWorkerFetch(pool: WorkerManager): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = request.body ? await request.text() : undefined
    const result = await pool.client.call("fetch", {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }
  return fn as typeof fetch
}

function createEventSource(pool: WorkerManager): EventSource {
  return {
    on: (handler) => {
      const unsub = pool.client.on<Event>("event", handler)
      return () => {
        unsub()
      }
    },
  }
}

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: "start opencode tui",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", {
        type: "string",
        describe: "path to start opencode in",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      }),
  handler: async (args) => {
    // Resolve relative paths against PWD to preserve behavior when using --cwd flag
    const baseCwd = process.env.PWD ?? process.cwd()
    const cwd = args.project ? path.resolve(baseCwd, args.project) : process.cwd()
    const localWorker = new URL("./worker.ts", import.meta.url)
    const distWorker = new URL("./cli/cmd/tui/worker.js", import.meta.url)
    const workerPath = await iife(async () => {
      if (typeof OPENCODE_WORKER_PATH !== "undefined") return OPENCODE_WORKER_PATH
      if (await File.exists(distWorker.pathname)) return distWorker
      return localWorker
    })
    try {
      process.chdir(cwd)
    } catch {
      UI.error("Failed to change directory to " + cwd)
      return
    }

    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    )
    const pool = createWorkerManager(workerPath, env)

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
      const piped = !process.stdin.isTTY ? await Util.stdinText() : undefined
      if (!args.prompt) return piped
      return piped ? piped + "\n" + args.prompt : args.prompt
    })

    // Check if server should be started (port or hostname explicitly set in CLI or config)
    const networkOpts = await resolveNetworkOptions(args)
    const shouldStartServer =
      process.argv.includes("--port") ||
      process.argv.includes("--hostname") ||
      process.argv.includes("--mdns") ||
      networkOpts.mdns ||
      networkOpts.port !== 0 ||
      networkOpts.hostname !== "127.0.0.1"

    let url: string
    let customFetch: typeof fetch | undefined
    let events: EventSource | undefined

    if (shouldStartServer) {
      // Start HTTP server for external access
      const server = await pool.client.call("server", networkOpts)
      url = server.url
    } else {
      // Use direct RPC communication (no HTTP)
      url = "http://opencode.internal"
      customFetch = createWorkerFetch(pool)
      events = createEventSource(pool)
    }

    // Memory monitoring for diagnostics (logging only, no restart)
    // This helps track Bun's native memory leak (see: https://github.com/oven-sh/bun/issues/15020)
    const memoryMonitorInterval = setInterval(async () => {
      try {
        const mem = await pool.client.call("memory", undefined)
        const rssMB = (mem.rss / 1024 / 1024).toFixed(0)
        const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(0)
        Log.Default.info("worker memory", { rss: rssMB + " MB", heap: heapMB + " MB" })
      } catch {
        // Ignore errors during memory check
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
      },
      onExit: async () => {
        clearInterval(memoryMonitorInterval)
        await pool.shutdown()
      },
    })

    setTimeout(() => {
      pool.client.call("checkUpgrade", { directory: cwd }).catch(() => {})
    }, 1000)

    await tuiPromise
  },
})
