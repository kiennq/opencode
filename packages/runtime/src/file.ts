/**
 * File operations abstraction
 */

import type { FileStat, FileWriteOptions, RuntimeAdapter } from "./types"
import { detectRuntime } from "./types"

/**
 * File namespace - provides file operations using the current runtime adapter
 */
export namespace File {
  let adapter: RuntimeAdapter["file"] | null = null
  let initPromise: Promise<void> | null = null

  export function setAdapter(a: RuntimeAdapter["file"]) {
    adapter = a
  }

  async function ensureAdapter(): Promise<RuntimeAdapter["file"]> {
    if (adapter) return adapter

    // Auto-initialize on first use
    if (!initPromise) {
      initPromise = (async () => {
        const runtime = detectRuntime()
        switch (runtime) {
          case "bun": {
            const { BunAdapter } = await import("./adapters/bun")
            adapter = BunAdapter.file
            break
          }
          case "deno": {
            const { DenoAdapter } = await import("./adapters/deno")
            adapter = DenoAdapter.file
            break
          }
          case "node": {
            const { NodeAdapter } = await import("./adapters/node")
            adapter = NodeAdapter.file
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
   * Read file contents as text
   */
  export async function read(path: string): Promise<string> {
    const a = await ensureAdapter()
    return a.read(path)
  }

  /**
   * Read file contents as bytes
   */
  export async function readBytes(path: string): Promise<Uint8Array> {
    const a = await ensureAdapter()
    return a.readBytes(path)
  }

  /**
   * Write content to a file
   */
  export async function write(path: string, content: string | Uint8Array, options?: FileWriteOptions): Promise<void> {
    const a = await ensureAdapter()
    return a.write(path, content, options)
  }

  /**
   * Check if a file exists
   */
  export async function exists(path: string): Promise<boolean> {
    const a = await ensureAdapter()
    return a.exists(path)
  }

  /**
   * Get file statistics
   */
  export async function stat(path: string): Promise<FileStat> {
    const a = await ensureAdapter()
    return a.stat(path)
  }

  /**
   * Remove a file
   */
  export async function remove(path: string): Promise<void> {
    const a = await ensureAdapter()
    return a.remove(path)
  }
}
