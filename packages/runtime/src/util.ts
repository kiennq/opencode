/**
 * Utility operations abstraction
 */

import type { RuntimeAdapter } from "./types"

/**
 * Util namespace - provides utility operations using the current runtime adapter
 */
export namespace Util {
  let adapter: RuntimeAdapter["util"] | null = null

  export function setAdapter(a: RuntimeAdapter["util"]) {
    adapter = a
  }

  function getAdapter(): RuntimeAdapter["util"] {
    if (!adapter) throw new Error("Runtime adapter not initialized. Call Runtime.init() first.")
    return adapter
  }

  /**
   * Sleep for a given number of milliseconds
   */
  export function sleep(ms: number): Promise<void> {
    return getAdapter().sleep(ms)
  }

  /**
   * Trigger garbage collection (if available in the runtime)
   */
  export function gc(): void {
    return getAdapter().gc()
  }

  /**
   * Get the display width of a string (accounting for wide characters)
   */
  export function stringWidth(str: string): number {
    return getAdapter().stringWidth(str)
  }

  /**
   * Convert a ReadableStream to text
   */
  export function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
    return getAdapter().streamToText(stream)
  }

  /**
   * Convert a ReadableStream to bytes
   */
  export function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    return getAdapter().streamToBytes(stream)
  }
}
