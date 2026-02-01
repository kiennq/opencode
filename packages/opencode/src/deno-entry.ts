/**
 * Deno entry point for opencode
 *
 * This file is the entry point when running opencode with Deno runtime.
 * It initializes the Deno runtime adapter and then loads the main application.
 */

// Initialize the Deno runtime adapter before importing the main app
import { Runtime } from "@opencode-ai/runtime"
import { DenoAdapter } from "@opencode-ai/runtime/adapters/deno"

// Initialize runtime with Deno adapter
await Runtime.init(DenoAdapter)

// Now import and run the main application
// Note: The main app needs to be adapted to use the runtime abstraction layer
// For now, we just re-export to show the structure

console.log("OpenCode - Deno Runtime")
console.log("Runtime initialized:", Runtime.name())

// TODO: Import the main CLI after adapting it to use the runtime abstraction
// import "./index.ts"

// Placeholder - show that Deno is working
const args = Deno.args
if (args.includes("--version") || args.includes("-v")) {
  console.log(`opencode ${Deno.env.get("OPENCODE_VERSION") ?? "dev"}`)
} else if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Usage: opencode [command] [options]

Commands:
  run         Run the AI assistant
  serve       Start the HTTP server
  auth        Manage authentication
  models      List available models

Options:
  -h, --help     Show help
  -v, --version  Show version

Note: This is the Deno version. Full functionality coming soon.
  `)
} else {
  console.log("Run with --help for usage information")
}
