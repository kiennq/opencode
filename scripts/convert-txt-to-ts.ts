#!/usr/bin/env bun
/**
 * Script to convert .txt imports to .ts files for Deno compatibility.
 * Bun supports importing .txt files natively, but Deno doesn't.
 * This script converts .txt files to .ts files that export the text as a default string.
 */

import { readFile, writeFile, unlink, readdir } from "node:fs/promises"
import { join, dirname, basename } from "node:path"

const SRC_DIR = join(import.meta.dirname!, "../packages/opencode/src")

async function findFiles(dir: string, ext: string): Promise<string[]> {
  const files: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await findFiles(fullPath, ext)))
    } else if (entry.name.endsWith(ext)) {
      files.push(fullPath)
    }
  }

  return files
}

async function findTsFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await findTsFiles(fullPath)))
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      files.push(fullPath)
    }
  }

  return files
}

async function main() {
  console.log("🔍 Finding .txt files in src/...")

  // Find all .txt files
  const txtFiles = await findFiles(SRC_DIR, ".txt")
  console.log(`   Found ${txtFiles.length} .txt files\n`)

  console.log("🔧 Converting .txt files to .ts modules...\n")

  for (const txtFile of txtFiles) {
    const content = await readFile(txtFile, "utf-8")
    const tsFile = txtFile.replace(".txt", ".txt.ts")

    // Create a .ts file that exports the text content
    // We use template literals to preserve newlines and special characters
    const tsContent = `// Auto-generated from ${basename(txtFile)}
export default ${JSON.stringify(content)}
`

    await writeFile(tsFile, tsContent, "utf-8")

    const relativePath = txtFile.replace(SRC_DIR, "src")
    console.log(`   ✅ ${relativePath} → ${basename(tsFile)}`)
  }

  console.log("\n📝 Now updating imports in .ts files...")

  // Find all .ts files and update imports from .txt to .txt.ts
  const tsFiles = await findTsFiles(SRC_DIR)

  let filesUpdated = 0
  let importsUpdated = 0

  for (const tsFile of tsFiles) {
    const content = await readFile(tsFile, "utf-8")

    // Replace imports ending with .txt" to .txt.ts"
    const newContent = content.replace(/from\s+["']([^"']+)\.txt["']/g, (match, path) => {
      importsUpdated++
      return `from "${path}.txt.ts"`
    })

    if (newContent !== content) {
      await writeFile(tsFile, newContent, "utf-8")
      filesUpdated++
    }
  }

  console.log(`   Updated ${importsUpdated} imports in ${filesUpdated} files\n`)

  console.log("📊 Summary:")
  console.log(`   .txt files converted: ${txtFiles.length}`)
  console.log(`   TypeScript files updated: ${filesUpdated}`)
  console.log(`   Total imports updated: ${importsUpdated}`)

  console.log("\n⚠️  Note: The original .txt files are kept for reference.")
  console.log("   You can delete them manually if no longer needed.")
}

main().catch(console.error)
