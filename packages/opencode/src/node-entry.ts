/**
 * Node.js entry point for opencode
 *
 * This file is the entry point when running opencode with Node.js runtime.
 * It initializes the Node.js runtime adapter and then loads the main application.
 */

// Initialize the Node.js runtime adapter before importing the main app
import { Runtime } from "@opencode-ai/runtime"
import { NodeAdapter } from "@opencode-ai/runtime/adapters/node"

// Initialize runtime with Node adapter
await Runtime.init(NodeAdapter)

// Now import and run the main application
// Note: The main app needs to be adapted to use the runtime abstraction layer
// For now, we just re-export to show the structure

console.log("OpenCode - Node.js Runtime")
console.log("Runtime initialized:", Runtime.name())

// TODO: Import the main CLI after ensuring all Node.js compatibility is verified
// import "./index.ts"

// Placeholder - show that Node.js is working
const args = process.argv.slice(2)
if (args.includes("--version") || args.includes("-v")) {
  console.log(`opencode ${process.env.OPENCODE_VERSION ?? "dev"}`)
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

Note: This is the Node.js version. Full functionality coming soon.
  `)
} else {
  console.log("Run with --help for usage information")
}
