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

/**
 * Process namespace - provides process operations using the current runtime adapter
 */
export namespace Process {
  let adapter: RuntimeAdapter["process"] | null = null

  export function setAdapter(a: RuntimeAdapter["process"]) {
    adapter = a
  }

  function getAdapter(): RuntimeAdapter["process"] {
    if (!adapter) throw new Error("Runtime adapter not initialized. Call Runtime.init() first.")
    return adapter
  }

  /**
   * Spawn a subprocess
   */
  export function spawn(command: string[], options?: SpawnOptions): Subprocess {
    return getAdapter().spawn(command, options)
  }

  /**
   * Spawn a subprocess synchronously
   */
  export function spawnSync(command: string[], options?: SpawnOptions): SpawnResult {
    return getAdapter().spawnSync(command, options)
  }

  /**
   * Execute a shell command
   */
  export function exec(command: string, options?: ShellOptions): Promise<ShellResult> {
    return getAdapter().exec(command, options)
  }

  /**
   * Find an executable in PATH
   */
  export function which(name: string, options?: WhichOptions): string | null {
    return getAdapter().which(name, options)
  }

  /**
   * Resolve a module specifier to its file path
   */
  export function resolve(specifier: string, parent: string): Promise<string | undefined> {
    return getAdapter().resolve(specifier, parent)
  }
}
