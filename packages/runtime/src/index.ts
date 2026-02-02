/**
 * Runtime abstraction layer for cross-runtime compatibility.
 *
 * This module provides a unified interface that works across Bun, Deno, and Node.js.
 * The implementation is selected at build time or runtime based on the environment.
 *
 * Usage:
 * ```typescript
 * import { Runtime, File, Process, Glob, Util } from "@opencode-ai/runtime"
 *
 * // Initialize the runtime (auto-detects Bun, Deno, or Node.js)
 * await Runtime.init()
 *
 * // Use the abstracted APIs
 * const content = await File.read("file.txt")
 * const result = Process.spawnSync(["ls", "-la"])
 * ```
 *
 * To use a specific adapter, import it directly:
 * ```typescript
 * import { Runtime } from "@opencode-ai/runtime"
 * import { NodeAdapter } from "@opencode-ai/runtime/adapters/node"
 * await Runtime.init(NodeAdapter)
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

// Note: Adapters are NOT re-exported here to avoid loading runtime-specific code
// in incompatible environments. Import adapters directly from their paths:
// - import { BunAdapter } from "@opencode-ai/runtime/adapters/bun"
// - import { DenoAdapter } from "@opencode-ai/runtime/adapters/deno"
// - import { NodeAdapter } from "@opencode-ai/runtime/adapters/node"
