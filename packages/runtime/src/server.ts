/**
 * Server operations abstraction
 */

import type { ServeOptions, ServerHandle, RuntimeAdapter } from "./types"
import { detectRuntime } from "./types"

/**
 * Server namespace - provides HTTP server operations using the current runtime adapter
 */
export namespace Server {
  let adapter: RuntimeAdapter["server"] | null = null

  export function setAdapter(a: RuntimeAdapter["server"]) {
    adapter = a
  }

  function ensureAdapterSync(): RuntimeAdapter["server"] {
    if (adapter) return adapter

    // Synchronously initialize for sync methods
    const runtime = detectRuntime()
    switch (runtime) {
      case "bun": {
        const { BunAdapter } = require("./adapters/bun")
        adapter = BunAdapter.server
        break
      }
      case "deno": {
        throw new Error("Server.serve requires async initialization for Deno. Call Runtime.init() first.")
      }
      default:
        throw new Error(`Unsupported runtime: ${runtime}`)
    }
    return adapter!
  }

  /**
   * Start an HTTP server
   */
  export function serve<T>(options: ServeOptions<T>): ServerHandle {
    return ensureAdapterSync().serve(options)
  }
}
