/**
 * Glob operations abstraction
 */

import type { GlobOptions, RuntimeAdapter } from "./types"

/**
 * Glob namespace - provides glob operations using the current runtime adapter
 */
export namespace Glob {
  let adapter: RuntimeAdapter["glob"] | null = null

  export function setAdapter(a: RuntimeAdapter["glob"]) {
    adapter = a
  }

  function getAdapter(): RuntimeAdapter["glob"] {
    if (!adapter) throw new Error("Runtime adapter not initialized. Call Runtime.init() first.")
    return adapter
  }

  /**
   * Scan for files matching a glob pattern
   */
  export function scan(pattern: string, options?: GlobOptions): AsyncIterable<string> {
    return getAdapter().scan(pattern, options)
  }

  /**
   * Scan for files matching a glob pattern (synchronous)
   */
  export function scanSync(pattern: string, options?: GlobOptions): Iterable<string> {
    return getAdapter().scanSync(pattern, options)
  }

  /**
   * Test if a path matches a glob pattern
   */
  export function match(pattern: string, path: string): boolean {
    return getAdapter().match(pattern, path)
  }
}
