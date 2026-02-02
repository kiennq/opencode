import { File, Process, $, Runtime } from "./packages/runtime/src/index.ts"

console.log("Testing Deno runtime...")

// Initialize the runtime first
await Runtime.init()

// Test File operations
const testFile = "./test-deno-file.txt"
await File.write(testFile, "Hello from Deno!")
const content = await File.read(testFile)
console.log("File content:", content)
await File.remove(testFile)

// Test Process
const result = Process.spawnSync(["echo", "Hello from spawn"])
console.log("SpawnSync result:", result.stdout.trim())

// Test shell
const shellResult = await $`echo Hello from shell`.quiet()
console.log("Shell result:", shellResult.text())

console.log("All tests passed!")
