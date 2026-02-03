/**
 * Glob operations abstraction
 */

import type { GlobOptions, RuntimeAdapter } from "./types"
import { detectRuntime } from "./types"

/**
 * Glob namespace - provides glob operations using the current runtime adapter
 */
export namespace Glob {
  let adapter: RuntimeAdapter["glob"] | null = null
  let initPromise: Promise<void> | null = null

  export function setAdapter(a: RuntimeAdapter["glob"]) {
    adapter = a
  }

  function ensureAdapterSync(): RuntimeAdapter["glob"] {
    if (adapter) return adapter

    // Synchronously initialize for sync methods
    const runtime = detectRuntime()
    switch (runtime) {
      case "bun": {
        const { BunAdapter } = require("./adapters/bun")
        adapter = BunAdapter.glob
        break
      }
      case "node": {
        const { NodeAdapter } = require("./adapters/node")
        adapter = NodeAdapter.glob
        break
      }
      case "deno": {
        throw new Error("Glob.scanSync/match requires async initialization for Deno. Call Runtime.init() first.")
      }
      default:
        throw new Error(`Unsupported runtime: ${runtime}`)
    }
    return adapter!
  }

  async function ensureAdapter(): Promise<RuntimeAdapter["glob"]> {
    if (adapter) return adapter

    if (!initPromise) {
      initPromise = (async () => {
        const runtime = detectRuntime()
        switch (runtime) {
          case "bun": {
            const { BunAdapter } = await import("./adapters/bun")
            adapter = BunAdapter.glob
            break
          }
          case "node": {
            const { NodeAdapter } = await import("./adapters/node")
            adapter = NodeAdapter.glob
            break
          }
          case "deno": {
            const { DenoAdapter } = await import("./adapters/deno")
            adapter = DenoAdapter.glob
            break
          }
          default:
            throw new Error(`Unsupported runtime: ${runtime}`)
        }
      })()
    }
    await initPromise
    return adapter!
  }

  /**
   * Scan for files matching a glob pattern
   */
  export async function* scan(pattern: string, options?: GlobOptions): AsyncIterable<string> {
    const a = await ensureAdapter()
    yield* a.scan(pattern, options)
  }

  /**
   * Scan for files matching a glob pattern (synchronous)
   */
  export function scanSync(pattern: string, options?: GlobOptions): Iterable<string> {
    return ensureAdapterSync().scanSync(pattern, options)
  }

  /**
   * Test if a path matches a glob pattern
   */
  export function match(pattern: string, path: string): boolean {
    return ensureAdapterSync().match(pattern, path)
  }
}
