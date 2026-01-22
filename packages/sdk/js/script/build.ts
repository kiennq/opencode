#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"

const dir = import.meta.dir
const root = path.resolve(dir, "..")
process.chdir(root)

import { createClient } from "@hey-api/openapi-ts"

await $`bun dev generate > ${root}/openapi.json`.cwd(path.resolve(root, "../../opencode"))

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(root, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

import { rmdir } from "node:fs/promises"

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
const dist = path.join(root, "dist")
await rmdir(dist, { recursive: true }).catch(() => {})
await $`bun tsc`
await Bun.file(path.join(root, "openapi.json")).delete()
