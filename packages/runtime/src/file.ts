/**
 * File operations abstraction
 */

import type { FileStat, FileWriteOptions, RuntimeAdapter } from "./types"

/**
 * File namespace - provides file operations using the current runtime adapter
 */
export namespace File {
  let adapter: RuntimeAdapter["file"] | null = null

  export function setAdapter(a: RuntimeAdapter["file"]) {
    adapter = a
  }

  function getAdapter(): RuntimeAdapter["file"] {
    if (!adapter) throw new Error("Runtime adapter not initialized. Call Runtime.init() first.")
    return adapter
  }

  /**
   * Read file contents as text
   */
  export function read(path: string): Promise<string> {
    return getAdapter().read(path)
  }

  /**
   * Read file contents as bytes
   */
  export function readBytes(path: string): Promise<Uint8Array> {
    return getAdapter().readBytes(path)
  }

  /**
   * Write content to a file
   */
  export function write(path: string, content: string | Uint8Array, options?: FileWriteOptions): Promise<void> {
    return getAdapter().write(path, content, options)
  }

  /**
   * Check if a file exists
   */
  export function exists(path: string): Promise<boolean> {
    return getAdapter().exists(path)
  }

  /**
   * Get file statistics
   */
  export function stat(path: string): Promise<FileStat> {
    return getAdapter().stat(path)
  }

  /**
   * Remove a file
   */
  export function remove(path: string): Promise<void> {
    return getAdapter().remove(path)
  }
}
