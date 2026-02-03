/**
 * Utility operations abstraction
 */

import type { RuntimeAdapter } from "./types"
import { detectRuntime } from "./types"

/**
 * Util namespace - provides utility operations using the current runtime adapter
 */
export namespace Util {
  let adapter: RuntimeAdapter["util"] | null = null
  let initPromise: Promise<void> | null = null

  export function setAdapter(a: RuntimeAdapter["util"]) {
    adapter = a
  }

  function ensureAdapterSync(): RuntimeAdapter["util"] {
    if (adapter) return adapter

    // Synchronously initialize for sync methods
    const runtime = detectRuntime()
    switch (runtime) {
      case "bun": {
        const { BunAdapter } = require("./adapters/bun")
        adapter = BunAdapter.util
        break
      }
      case "node": {
        const { NodeAdapter } = require("./adapters/node")
        adapter = NodeAdapter.util
        break
      }
      case "deno": {
        throw new Error("Util sync methods require async initialization for Deno. Call Runtime.init() first.")
      }
      default:
        throw new Error(`Unsupported runtime: ${runtime}`)
    }
    return adapter!
  }

  async function ensureAdapter(): Promise<RuntimeAdapter["util"]> {
    if (adapter) return adapter

    if (!initPromise) {
      initPromise = (async () => {
        const runtime = detectRuntime()
        switch (runtime) {
          case "bun": {
            const { BunAdapter } = await import("./adapters/bun")
            adapter = BunAdapter.util
            break
          }
          case "node": {
            const { NodeAdapter } = await import("./adapters/node")
            adapter = NodeAdapter.util
            break
          }
          case "deno": {
            const { DenoAdapter } = await import("./adapters/deno")
            adapter = DenoAdapter.util
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
   * Sleep for a given number of milliseconds
   */
  export async function sleep(ms: number): Promise<void> {
    const a = await ensureAdapter()
    return a.sleep(ms)
  }

  /**
   * Trigger garbage collection (if available in the runtime)
   */
  export function gc(): void {
    return ensureAdapterSync().gc()
  }

  /**
   * Get the display width of a string (accounting for wide characters)
   */
  export function stringWidth(str: string): number {
    return ensureAdapterSync().stringWidth(str)
  }

  /**
   * Convert a ReadableStream to text
   */
  export async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
    const a = await ensureAdapter()
    return a.streamToText(stream)
  }

  /**
   * Convert a ReadableStream to bytes
   */
  export async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const a = await ensureAdapter()
    return a.streamToBytes(stream)
  }

  /**
   * Read all stdin as text
   */
  export async function stdinText(): Promise<string> {
    const a = await ensureAdapter()
    return a.stdinText()
  }
}
