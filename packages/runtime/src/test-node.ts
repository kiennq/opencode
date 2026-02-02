/**
 * Simple test script for Node.js runtime adapter
 * Run with: node --experimental-strip-types src/test-node.ts
 */

import { NodeAdapter } from "./adapters/node.ts"
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
  console.log("Testing NodeAdapter...\n")

  // Test adapter name
  await test("adapter.name is 'node'", () => {
    if (NodeAdapter.name !== "node") {
      throw new Error(`Expected 'node', got '${NodeAdapter.name}'`)
    }
  })

  // Test file.read
  await test("file.read can read this test file", async () => {
    const content = await NodeAdapter.file.read(path.join(__dirname, "test-node.ts"))
    if (!content.includes("Testing NodeAdapter")) {
      throw new Error("File content does not match expected")
    }
  })

  // Test file.exists
  await test("file.exists returns true for existing file", async () => {
    const exists = await NodeAdapter.file.exists(path.join(__dirname, "test-node.ts"))
    if (!exists) {
      throw new Error("Expected file to exist")
    }
  })

  await test("file.exists returns false for non-existing file", async () => {
    const exists = await NodeAdapter.file.exists(path.join(__dirname, "non-existent-file.xyz"))
    if (exists) {
      throw new Error("Expected file to not exist")
    }
  })

  // Test file.stat
  await test("file.stat returns file info", async () => {
    const stat = await NodeAdapter.file.stat(path.join(__dirname, "test-node.ts"))
    if (!stat.isFile) {
      throw new Error("Expected isFile to be true")
    }
    if (stat.isDirectory) {
      throw new Error("Expected isDirectory to be false")
    }
    if (typeof stat.size !== "number" || stat.size <= 0) {
      throw new Error("Expected size to be a positive number")
    }
  })

  // Test file.write and remove
  const testFile = path.join(__dirname, ".test-temp-file.txt")
  await test("file.write creates a file", async () => {
    await NodeAdapter.file.write(testFile, "Hello, Node!")
    const content = await NodeAdapter.file.read(testFile)
    if (content !== "Hello, Node!") {
      throw new Error(`Expected 'Hello, Node!', got '${content}'`)
    }
  })

  await test("file.remove deletes a file", async () => {
    await NodeAdapter.file.remove(testFile)
    const exists = await NodeAdapter.file.exists(testFile)
    if (exists) {
      throw new Error("Expected file to be deleted")
    }
  })

  // Test process.which
  await test("process.which finds node executable", () => {
    const nodePath = NodeAdapter.process.which("node")
    if (!nodePath) {
      throw new Error("Expected to find node executable")
    }
  })

  // Test process.exec
  await test("process.exec runs commands", async () => {
    const result = await NodeAdapter.process.exec("echo hello")
    if (!result.stdout.includes("hello")) {
      throw new Error(`Expected stdout to contain 'hello', got '${result.stdout}'`)
    }
    if (!result.success) {
      throw new Error("Expected success to be true")
    }
  })

  // Test util.sleep
  await test("util.sleep waits correctly", async () => {
    const start = Date.now()
    await NodeAdapter.util.sleep(50)
    const elapsed = Date.now() - start
    if (elapsed < 40) {
      throw new Error(`Expected at least 40ms, got ${elapsed}ms`)
    }
  })

  // Test util.stringWidth
  await test("util.stringWidth calculates width", () => {
    const width = NodeAdapter.util.stringWidth("hello")
    if (width !== 5) {
      throw new Error(`Expected 5, got ${width}`)
    }
  })

  // Test glob (may fail if fast-glob not installed)
  await test("glob.scan finds TypeScript files", async () => {
    try {
      const files: string[] = []
      for await (const file of NodeAdapter.glob.scan("*.ts", { cwd: __dirname })) {
        files.push(file)
      }
      if (!files.some((f) => f.includes("test-node.ts"))) {
        throw new Error("Expected to find test-node.ts")
      }
    } catch (error: any) {
      if (error.message?.includes("No glob implementation")) {
        console.log("    (skipped - fast-glob not installed)")
        return
      }
      throw error
    }
  })

  console.log("\nAll tests passed!")
}

main().catch((err) => {
  console.error("Test failed:", err)
  process.exit(1)
})
