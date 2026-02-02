/**
 * Node.js entry point for opencode
 *
 * This file is the entry point when running opencode with Node.js runtime.
 * It initializes the Node.js runtime adapter before importing the main application.
 *
 * Usage:
 *   npx tsx src/node-entry.ts [command] [options]
 *   node --experimental-strip-types src/node-entry.ts [command] [options]
 */

// Initialize the Node.js runtime adapter before importing anything else
import { Runtime } from "@opencode-ai/runtime"
import { NodeAdapter } from "@opencode-ai/runtime/adapters/node"

// Initialize runtime with Node adapter FIRST
// This must happen before any other imports that use runtime APIs
await Runtime.init(NodeAdapter)

// Now dynamically import and run the main application
// The main app calls Runtime.init() which will be a no-op since we already initialized
try {
  // Import the main index which sets up yargs and runs the CLI
  await import("./index")
} catch (error) {
  // Handle any errors during import/execution
  if (error instanceof Error) {
    console.error("Error:", error.message)
    if (process.env.DEBUG) {
      console.error(error.stack)
    }
  } else {
    console.error("Unknown error:", error)
  }
  process.exit(1)
}
