/**
 * Node.js-compatible entry point for opencode
 *
 * This file is similar to index.ts but excludes commands that require Bun-specific
 * dependencies like the TUI (@opentui/core) and PTY (bun-pty).
 *
 * Available commands on Node.js:
 * - run: Run in non-interactive mode
 * - generate: Generate API specs
 * - auth: Manage authentication
 * - agent: List agents
 * - upgrade: Upgrade opencode
 * - uninstall: Uninstall opencode
 * - serve: Start the HTTP server (with limited WebSocket support)
 * - models: List available models
 * - debug: Debug commands
 * - stats: Show statistics
 * - export: Export sessions
 * - import: Import sessions
 * - mcp: MCP tools
 * - github: GitHub integration
 * - acp: Agentic Coding Protocol
 * - pr: Pull request operations
 * - session: Session management
 * - web: Open web interface
 *
 * Commands NOT available on Node.js (require Bun):
 * - attach: Attach to server (requires TUI)
 * - thread: Interactive thread (requires TUI)
 * - [default]: Interactive TUI mode (requires TUI/PTY)
 */

import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { Runtime } from "@opencode-ai/runtime"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import { Log } from "./util/log"
import { AuthCommand } from "./cli/cmd/auth"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { UI } from "./cli/ui"
import { Installation } from "./installation/index"
import { NamedError } from "@opencode-ai/util/error"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { GithubCommand } from "./cli/cmd/github"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "node:os"
import { WebCommand } from "./cli/cmd/web"
import { PrCommand } from "./cli/cmd/pr"
import { SessionCommand } from "./cli/cmd/session"
import { Instance } from "./project/instance"
import { startRefreshInterval } from "./provider/models"

// Initialize the runtime adapter (auto-detects Node.js, Bun or Deno)
await Runtime.init()

// Start model refresh interval after runtime is initialized
startRefreshInterval()

// Track whether cleanup has been performed to avoid duplicate cleanup
let cleanupPerformed = false

// Cleanup handler to dispose all instances (closes MCP clients, LSP servers, etc.)
async function performCleanup(signal: string) {
  if (cleanupPerformed) return
  cleanupPerformed = true

  Log.Default.info("cleanup triggered by signal", { signal })
  try {
    await Instance.disposeAll()
  } catch (error) {
    Log.Default.error("error during cleanup", { error })
  }
}

// Register signal handlers for cleanup
const signals = ["SIGTERM", "SIGINT"] as const
for (const signal of signals) {
  process.on(signal, () => {
    performCleanup(signal).finally(() => {
      process.exit(128 + (signal === "SIGINT" ? 2 : 15))
    })
  })
}

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

// Main function that wraps the CLI with proper cleanup
async function main() {
  const cli = yargs(hideBin(process.argv))
    .parserConfiguration({ "populate--": true })
    .scriptName("opencode")
    .wrap(100)
    .help("help", "show help")
    .alias("help", "h")
    .version("version", "show version number", Installation.VERSION)
    .alias("version", "v")
    .option("print-logs", {
      describe: "print logs to stderr",
      type: "boolean",
    })
    .option("log-level", {
      describe: "log level",
      type: "string",
      choices: ["DEBUG", "INFO", "WARN", "ERROR"],
    })
    .middleware(async (opts) => {
      await Log.init({
        print: process.argv.includes("--print-logs"),
        dev: Installation.isLocal(),
        level: (() => {
          if (opts.logLevel) return opts.logLevel as Log.Level
          if (Installation.isLocal()) return "DEBUG"
          return "INFO"
        })(),
      })

      process.env.AGENT = "1"
      process.env.OPENCODE = "1"

      Log.Default.info("opencode (Node.js)", {
        version: Installation.VERSION,
        args: process.argv.slice(2),
        runtime: Runtime.name,
      })
    })
    .usage("\n" + UI.logo() + "\n  (Node.js runtime - some features unavailable)")
    .completion("completion", "generate shell completion script")
    // Commands available on Node.js
    .command(AcpCommand)
    .command(McpCommand)
    .command(RunCommand)
    .command(GenerateCommand)
    .command(DebugCommand)
    .command(AuthCommand)
    .command(AgentCommand)
    .command(UpgradeCommand)
    .command(UninstallCommand)
    .command(ServeCommand)
    .command(WebCommand)
    .command(ModelsCommand)
    .command(StatsCommand)
    .command(ExportCommand)
    .command(ImportCommand)
    .command(GithubCommand)
    .command(PrCommand)
    .command(SessionCommand)
    // Note: AttachCommand and TuiThreadCommand excluded - require Bun (TUI/PTY)
    .fail((msg, err) => {
      if (
        msg?.startsWith("Unknown argument") ||
        msg?.startsWith("Not enough non-option arguments") ||
        msg?.startsWith("Invalid values:")
      ) {
        if (err) throw err
        cli.showHelp("log")
      }
      if (err) throw err
      process.exit(1)
    })
    .strict()

  try {
    await cli.parse()
  } catch (e) {
    let data: Record<string, any> = {}
    if (e instanceof NamedError) {
      const obj = e.toObject()
      Object.assign(data, {
        ...obj.data,
      })
    }

    if (e instanceof Error) {
      Object.assign(data, {
        name: e.name,
        message: e.message,
        cause: e.cause?.toString(),
        stack: e.stack,
      })
    }

    if (e instanceof ResolveMessage) {
      Object.assign(data, {
        name: e.name,
        message: e.message,
        code: e.code,
        specifier: e.specifier,
        referrer: e.referrer,
        position: e.position,
        importKind: e.importKind,
      })
    }
    Log.Default.error("fatal", data)
    const formatted = FormatError(e)
    if (formatted) UI.error(formatted)
    if (formatted === undefined) {
      UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
      console.error(e instanceof Error ? e.message : String(e))
    }
    process.exitCode = 1
  }
}

// Run main with cleanup
try {
  await main()
  await performCleanup("main")
  process.exit(process.exitCode ?? 0)
} catch (error) {
  await performCleanup("error")
  process.exit(1)
}
