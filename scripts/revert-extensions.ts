#!/usr/bin/env bun
/**
 * Script to remove .ts/.tsx extensions from relative imports.
 * This reverts the Deno-specific extension additions while keeping
 * node: prefixes and .txt.ts imports.
 */

import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

const SRC_DIR = join(import.meta.dirname!, "../packages/opencode/src")

async function findTsFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await findTsFiles(fullPath)))
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      // Skip .txt.ts files
      if (!entry.name.endsWith(".txt.ts")) {
        files.push(fullPath)
      }
    }
  }

  return files
}

async function fixFile(filePath: string): Promise<{ fixed: number; file: string }> {
  const content = await readFile(filePath, "utf-8")
  let newContent = content
  let fixCount = 0

  // Remove .ts extension from relative imports (but NOT .txt.ts)
  // Match: from "./foo.ts" or from "../foo.ts" etc
  // But NOT: from "./foo.txt.ts"
  newContent = newContent.replace(/from\s+["'](\.\.?\/[^"']+)(?<!\.txt)\.ts["']/g, (match, path) => {
    fixCount++
    return `from "${path}"`
  })

  // Remove .tsx extension from relative imports
  newContent = newContent.replace(/from\s+["'](\.\.?\/[^"']+)\.tsx["']/g, (match, path) => {
    fixCount++
    return `from "${path}"`
  })

  // Remove /index.ts suffix from directory imports
  // from "./session/index.ts" -> from "./session"
  newContent = newContent.replace(/from\s+["'](\.\.?\/[^"']+)\/index\.ts["']/g, (match, path) => {
    fixCount++
    return `from "${path}"`
  })

  if (fixCount > 0) {
    await writeFile(filePath, newContent, "utf-8")
  }

  return { fixed: fixCount, file: filePath }
}

async function main() {
  console.log("🔍 Scanning for TypeScript files...")
  const files = await findTsFiles(SRC_DIR)
  console.log(`   Found ${files.length} TypeScript files\n`)

  console.log("🔧 Removing .ts/.tsx extensions from imports...\n")

  let totalFixed = 0
  const fixedFiles: string[] = []

  for (const file of files) {
    const result = await fixFile(file)
    if (result.fixed > 0) {
      const relativePath = file.replace(SRC_DIR, "src")
      console.log(`   ✅ ${relativePath}: ${result.fixed} import(s) fixed`)
      totalFixed += result.fixed
      fixedFiles.push(relativePath)
    }
  }

  console.log(`\n📊 Summary:`)
  console.log(`   Files modified: ${fixedFiles.length}`)
  console.log(`   Total imports fixed: ${totalFixed}`)
}

main().catch(console.error)
