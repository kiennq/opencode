/**
 * Process operations abstraction
 */

import type {
  SpawnOptions,
  SpawnResult,
  ShellOptions,
  ShellResult,
  Subprocess,
  RuntimeAdapter,
  WhichOptions,
} from "./types"
import { detectRuntime } from "./types"

/**
 * Process namespace - provides process operations using the current runtime adapter
 */
export namespace Process {
  let adapter: RuntimeAdapter["process"] | null = null
  let initPromise: Promise<void> | null = null

  export function setAdapter(a: RuntimeAdapter["process"]) {
    adapter = a
  }

  function ensureAdapterSync(): RuntimeAdapter["process"] {
    if (adapter) return adapter

    // Synchronously initialize for sync methods
    const runtime = detectRuntime()
    switch (runtime) {
      case "bun": {
        // Use require for sync initialization in Bun
        const { BunAdapter } = require("./adapters/bun")
        adapter = BunAdapter.process
        break
      }
      case "deno": {
        throw new Error("Process.spawn/spawnSync requires async initialization for Deno. Call Runtime.init() first.")
      }
      default:
        throw new Error(`Unsupported runtime: ${runtime}`)
    }
    return adapter!
  }

  async function ensureAdapter(): Promise<RuntimeAdapter["process"]> {
    if (adapter) return adapter

    if (!initPromise) {
      initPromise = (async () => {
        const runtime = detectRuntime()
        switch (runtime) {
          case "bun": {
            const { BunAdapter } = await import("./adapters/bun")
            adapter = BunAdapter.process
            break
          }
          case "deno": {
            const { DenoAdapter } = await import("./adapters/deno")
            adapter = DenoAdapter.process
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
   * Spawn a subprocess
   */
  export function spawn(command: string[], options?: SpawnOptions): Subprocess {
    return ensureAdapterSync().spawn(command, options)
  }

  /**
   * Spawn a subprocess synchronously
   */
  export function spawnSync(command: string[], options?: SpawnOptions): SpawnResult {
    return ensureAdapterSync().spawnSync(command, options)
  }

  /**
   * Execute a shell command
   */
  export async function exec(command: string, options?: ShellOptions): Promise<ShellResult> {
    const a = await ensureAdapter()
    return a.exec(command, options)
  }

  /**
   * Find an executable in PATH
   */
  export function which(name: string, options?: WhichOptions): string | null {
    return ensureAdapterSync().which(name, options)
  }

  /**
   * Resolve a module specifier to its file path
   */
  export async function resolve(specifier: string, parent: string): Promise<string | undefined> {
    const a = await ensureAdapter()
    return a.resolve(specifier, parent)
  }
}
