/**
 * Server abstraction for cross-runtime compatibility
 *
 * This module provides the server functionality with proper error handling
 * for runtimes that don't support all features.
 */

import { detectRuntime } from "@opencode-ai/runtime"

// Lazy-loaded server module
let _serverModule: typeof import("./server") | null = null

/**
 * Get the server module, loading it lazily
 * This allows the module to fail gracefully on unsupported runtimes
 */
async function getServerModule() {
  if (_serverModule) return _serverModule

  const runtime = detectRuntime()
  if (runtime === "node") {
    throw new Error(
      "The server functionality is not yet supported on Node.js. " +
        "Please use Bun or Deno runtime for server features.",
    )
  }

  _serverModule = await import("./server")
  return _serverModule
}

/**
 * Check if server features are available in the current runtime
 */
export function isServerAvailable(): boolean {
  return detectRuntime() !== "node"
}

/**
 * Proxy for Server namespace that provides lazy loading
 */
export const ServerProxy = {
  async listen(opts: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    const mod = await getServerModule()
    return mod.Server.listen(opts)
  },

  async App() {
    const mod = await getServerModule()
    return mod.Server.App()
  },

  async openapi() {
    const mod = await getServerModule()
    return mod.Server.openapi()
  },

  async url() {
    const mod = await getServerModule()
    return mod.Server.url()
  },
}
