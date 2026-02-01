/**
 * Server operations abstraction
 */

import type { ServeOptions, ServerHandle, RuntimeAdapter } from "./types"

/**
 * Server namespace - provides HTTP server operations using the current runtime adapter
 */
export namespace Server {
  let adapter: RuntimeAdapter["server"] | null = null

  export function setAdapter(a: RuntimeAdapter["server"]) {
    adapter = a
  }

  function getAdapter(): RuntimeAdapter["server"] {
    if (!adapter) throw new Error("Runtime adapter not initialized. Call Runtime.init() first.")
    return adapter
  }

  /**
   * Start an HTTP server
   */
  export function serve<T>(options: ServeOptions<T>): ServerHandle {
    return getAdapter().serve(options)
  }
}
