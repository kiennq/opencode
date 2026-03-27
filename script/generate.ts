#!/usr/bin/env bun

import { $ } from "bun"
import { format } from "./generate-lib"

await $`bun ./packages/sdk/js/script/build.ts`

await $`bun dev generate > ../sdk/openapi.json`.cwd("packages/opencode")

await $`${format()}`
