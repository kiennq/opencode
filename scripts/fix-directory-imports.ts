#!/usr/bin/env bun
/**
 * Script to fix imports for Deno compatibility.
 * 1. Adds /index.ts suffix to directory imports
 * 2. Adds .ts extension to file imports that are missing it
 */

import { readdir, readFile, writeFile, stat, access } from "node:fs/promises"
import { join, dirname, basename } from "node:path"

const SRC_DIR = join(import.meta.dirname!, "../packages/opencode/src")

// Pattern to match relative imports without extensions like:
// from "../session"
// from "./config"
// from "../../provider"
// from "./ui"
const RELATIVE_IMPORT_REGEX = /from\s+["'](\.\.?\/(?:\.\.\/)*[a-zA-Z][a-zA-Z0-9_-]*)["']/g

async function getAllTsFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await getAllTsFiles(fullPath)))
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      files.push(fullPath)
    }
  }

  return files
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function resolveImportType(
  filePath: string,
  importPath: string,
): Promise<"directory" | "file-ts" | "file-tsx" | "unknown"> {
  const fileDir = dirname(filePath)
  const resolvedPath = join(fileDir, importPath)

  // Check for file with .ts or .tsx extension FIRST (higher priority than directory)
  // This handles the case where both prompt.ts and prompt/ exist
  if (await exists(resolvedPath + ".ts")) {
    return "file-ts"
  }
  if (await exists(resolvedPath + ".tsx")) {
    return "file-tsx"
  }

  // Then check if it's a directory
  try {
    const stats = await stat(resolvedPath)
    if (stats.isDirectory()) {
      return "directory"
    }
  } catch {
    // Not a directory
  }

  return "unknown"
}

async function fixFile(filePath: string): Promise<{ fixed: number; file: string }> {
  const content = await readFile(filePath, "utf-8")
  let newContent = content
  let fixCount = 0

  // Fix 1: Handle from "." imports (current directory index)
  const dotImportRegex = /from\s+["']\.["']/g
  const dotMatches = [...content.matchAll(dotImportRegex)]
  for (const match of dotMatches) {
    const fullMatch = match[0]
    const newImport = fullMatch.replace('"."', '"./index.ts"').replace("'.'", "'./index.ts'")
    newContent = newContent.replace(fullMatch, newImport)
    fixCount++
  }

  // Fix 2: Handle from ".." imports (parent directory index)
  const dotDotImportRegex = /from\s+["']\.\.["']/g
  const dotDotMatches = [...newContent.matchAll(dotDotImportRegex)]
  for (const match of dotDotMatches) {
    const fullMatch = match[0]
    const newImport = fullMatch.replace('".."', '"../index.ts"').replace("'..'", "'../index.ts'")
    newContent = newContent.replace(fullMatch, newImport)
    fixCount++
  }

  // Fix 3: Handle other relative imports without extensions
  const matches = [...newContent.matchAll(RELATIVE_IMPORT_REGEX)]

  for (const match of matches) {
    const fullMatch = match[0]
    const importPath = match[1]
    if (!importPath) continue

    // Skip if already has extension
    if (importPath.endsWith(".ts") || importPath.endsWith(".tsx") || importPath.endsWith(".js")) {
      continue
    }

    const importType = await resolveImportType(filePath, importPath)

    if (importType === "directory") {
      // Replace with /index.ts suffix
      const newImport = fullMatch.replace(importPath, `${importPath}/index.ts`)
      newContent = newContent.replace(fullMatch, newImport)
      fixCount++
    } else if (importType === "file-ts") {
      // Replace with .ts suffix
      const newImport = fullMatch.replace(importPath, `${importPath}.ts`)
      newContent = newContent.replace(fullMatch, newImport)
      fixCount++
    } else if (importType === "file-tsx") {
      // Replace with .tsx suffix
      const newImport = fullMatch.replace(importPath, `${importPath}.tsx`)
      newContent = newContent.replace(fullMatch, newImport)
      fixCount++
    }
  }

  if (fixCount > 0) {
    await writeFile(filePath, newContent, "utf-8")
  }

  return { fixed: fixCount, file: filePath }
}

async function main() {
  console.log("🔍 Scanning for TypeScript files...")
  const files = await getAllTsFiles(SRC_DIR)
  console.log(`   Found ${files.length} TypeScript files\n`)

  console.log("🔧 Fixing imports for Deno compatibility...\n")

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
