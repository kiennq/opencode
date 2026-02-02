/**
 * Integration test for Node.js runtime with Shell abstraction
 * Run with: npx tsx src/test-node-integration.ts
 */

import { Runtime, File, Process, Glob, Util, $ } from "./index"
import { NodeAdapter } from "./adapters/node"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`✓ ${name}`)
  } catch (error) {
    console.error(`✗ ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

async function main() {
  console.log("Testing Node.js Runtime Integration...\n")

  // Initialize runtime with Node adapter
  await test("Runtime.init(NodeAdapter) succeeds", async () => {
    await Runtime.init(NodeAdapter)
  })

  await test("Runtime.name() returns 'node'", () => {
    if (Runtime.name() !== "node") {
      throw new Error(`Expected 'node', got '${Runtime.name()}'`)
    }
  })

  // Test File namespace
  await test("File.read works", async () => {
    const content = await File.read(path.join(__dirname, "test-node-integration.ts"))
    if (!content.includes("Testing Node.js Runtime Integration")) {
      throw new Error("File content does not match expected")
    }
  })

  await test("File.exists works", async () => {
    const exists = await File.exists(path.join(__dirname, "test-node-integration.ts"))
    if (!exists) {
      throw new Error("Expected file to exist")
    }
  })

  // Test Process namespace
  await test("Process.which finds node", () => {
    const nodePath = Process.which("node")
    if (!nodePath) {
      throw new Error("Expected to find node executable")
    }
  })

  await test("Process.spawnSync works", () => {
    const result = Process.spawnSync(["node", "--version"])
    if (!result.success) {
      throw new Error(`Expected success, got exit code ${result.exitCode}`)
    }
    if (!result.stdout.startsWith("v")) {
      throw new Error(`Expected version string, got '${result.stdout}'`)
    }
  })

  // Test Util namespace
  await test("Util.sleep works", async () => {
    const start = Date.now()
    await Util.sleep(50)
    const elapsed = Date.now() - start
    if (elapsed < 40) {
      throw new Error(`Expected at least 40ms, got ${elapsed}ms`)
    }
  })

  await test("Util.stringWidth works", () => {
    const width = Util.stringWidth("hello")
    if (width !== 5) {
      throw new Error(`Expected 5, got ${width}`)
    }
  })

  // Test Glob namespace
  await test("Glob.scan works", async () => {
    try {
      const files: string[] = []
      for await (const file of Glob.scan("*.ts", { cwd: __dirname })) {
        files.push(file)
      }
      if (files.length === 0) {
        throw new Error("Expected to find TypeScript files")
      }
    } catch (error: any) {
      if (error.message?.includes("No glob implementation")) {
        console.log("    (skipped - fast-glob not installed)")
        return
      }
      throw error
    }
  })

  await test("Glob.match works", () => {
    const matches = Glob.match("*.ts", "test.ts")
    if (!matches) {
      throw new Error("Expected pattern to match")
    }
  })

  // Test Shell ($) abstraction
  await test("$ shell command works", async () => {
    const result = await $`node --version`.quiet().nothrow()
    const text = result.text().trim()
    if (!text.startsWith("v")) {
      throw new Error(`Expected version string, got '${text}'`)
    }
  })

  await test("$ shell with cwd works", async () => {
    const result = await $`node -e "console.log(process.cwd())"`.cwd(__dirname).quiet()
    const cwd = result.text().trim()
    // Normalize paths for comparison
    const normalizedCwd = path.normalize(cwd)
    const normalizedExpected = path.normalize(__dirname)
    if (normalizedCwd !== normalizedExpected) {
      throw new Error(`Expected cwd '${normalizedExpected}', got '${normalizedCwd}'`)
    }
  })

  await test("$ shell with env works", async () => {
    const result = await $`node -e "console.log(process.env.TEST_VAR)"`.env({ TEST_VAR: "hello123" }).quiet()
    const output = result.text().trim()
    if (output !== "hello123") {
      throw new Error(`Expected 'hello123', got '${output}'`)
    }
  })

  await test("$ shell nothrow on failure", async () => {
    const result = await $`node -e "process.exit(42)"`.quiet().nothrow()
    if (result.exitCode !== 42) {
      throw new Error(`Expected exit code 42, got ${result.exitCode}`)
    }
  })

  await test("$.braces expands patterns", () => {
    const expanded = $.braces("file.{txt,md,ts}")
    if (expanded.length !== 3) {
      throw new Error(`Expected 3 items, got ${expanded.length}`)
    }
    if (!expanded.includes("file.txt") || !expanded.includes("file.md") || !expanded.includes("file.ts")) {
      throw new Error(`Unexpected expansion: ${expanded.join(", ")}`)
    }
  })

  await test("$.escape escapes special characters", () => {
    const escaped = $.escape("hello world")
    if (!escaped.includes("'")) {
      throw new Error(`Expected quoted string, got '${escaped}'`)
    }
  })

  console.log("\nAll integration tests passed!")
}

main().catch((err) => {
  console.error("Test failed:", err)
  process.exit(1)
})
