/**
 * Runtime abstraction layer for cross-runtime compatibility.
 *
 * This module provides a unified interface that works across Bun and Deno.
 * The implementation is selected at build time or runtime based on the environment.
 *
 * Usage:
 * ```typescript
 * import { Runtime, File, Process, Glob, Util } from "@opencode-ai/runtime"
 *
 * // Initialize the runtime (auto-detects Bun or Deno)
 * await Runtime.init()
 *
 * // Use the abstracted APIs
 * const content = await File.read("file.txt")
 * const result = Process.spawnSync(["ls", "-la"])
 * ```
 */

// Core types
export * from "./types"

// Abstraction namespaces
export * from "./file"
export * from "./process"
export * from "./glob"
export * from "./server"
export * from "./util"
export * from "./shell"

// Runtime adapter management
export { Runtime, autoInit } from "./adapter"

// Re-export adapters for direct use
export { BunAdapter } from "./adapters/bun"
export { DenoAdapter } from "./adapters/deno"
