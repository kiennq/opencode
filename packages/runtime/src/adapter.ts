/**
 * Runtime adapter initialization and export
 *
 * This module detects the current runtime and initializes the appropriate adapter.
 */

import type { RuntimeAdapter } from "./types"
import { detectRuntime } from "./types"
import { File } from "./file"
import { Process } from "./process"
import { Glob } from "./glob"
import { Server } from "./server"
import { Util } from "./util"

let currentAdapter: RuntimeAdapter | null = null

/**
 * Runtime namespace - manages the runtime adapter lifecycle
 */
export namespace Runtime {
  /**
   * Get the current runtime adapter
   */
  export function get(): RuntimeAdapter {
    if (!currentAdapter) {
      throw new Error("Runtime adapter not initialized. Call Runtime.init() first.")
    }
    return currentAdapter
  }

  /**
   * Initialize the runtime adapter
   * @param adapter - Optional specific adapter to use, otherwise auto-detects
   */
  export async function init(adapter?: RuntimeAdapter): Promise<RuntimeAdapter> {
    // If already initialized with an adapter, return it (idempotent)
    if (currentAdapter && !adapter) {
      return currentAdapter
    }

    if (adapter) {
      currentAdapter = adapter
    } else {
      const runtime = detectRuntime()
      currentAdapter = await loadAdapter(runtime)
    }

    // Wire up all namespaces
    File.setAdapter(currentAdapter.file)
    Process.setAdapter(currentAdapter.process)
    Glob.setAdapter(currentAdapter.glob)
    Server.setAdapter(currentAdapter.server)
    Util.setAdapter(currentAdapter.util)

    return currentAdapter
  }

  /**
   * Check if runtime has been initialized
   */
  export function isInitialized(): boolean {
    return currentAdapter !== null
  }

  /**
   * Get the name of the current runtime
   */
  export function name(): "bun" | "node" | "deno" {
    if (!currentAdapter) {
      return detectRuntime()
    }
    return currentAdapter.name
  }
}

/**
 * Load the adapter for the specified runtime
 */
async function loadAdapter(runtime: "bun" | "node" | "deno"): Promise<RuntimeAdapter> {
  switch (runtime) {
    case "bun": {
      const { BunAdapter } = await import("./adapters/bun")
      return BunAdapter
    }
    case "deno": {
      const { DenoAdapter } = await import("./adapters/deno")
      return DenoAdapter
    }
    case "node": {
      const { NodeAdapter } = await import("./adapters/node")
      return NodeAdapter
    }
    default:
      throw new Error(`Unknown runtime: ${runtime}`)
  }
}

/**
 * Auto-initialize on first import if possible
 * This is a convenience for simple use cases
 */
export async function autoInit(): Promise<void> {
  if (!Runtime.isInitialized()) {
    await Runtime.init()
  }
}
