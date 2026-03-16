import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { $ } from "bun"
import { tmpdir } from "../fixture/fixture"

test(
  "schema cli writes config schema with jsonc flags and explicit keys",
  async () => {
    await using tmp = await tmpdir()
    const out = path.join(tmp.path, "config.json")

    await $`bun ./script/schema.ts ${out}`.cwd(process.cwd())

    const json = JSON.parse(await fs.readFile(out, "utf8")) as {
      allowComments?: boolean
      allowTrailingCommas?: boolean
      properties?: Record<string, unknown>
    }

    expect(json.allowComments).toBe(true)
    expect(json.allowTrailingCommas).toBe(true)
    expect(json.properties?.username).toBeDefined()
    expect(json.properties?.provider).toBeDefined()
    const provider = json.properties?.provider as
      | {
          additionalProperties?: {
            properties?: {
              options?: {
                properties?: {
                  client?: unknown
                }
              }
            }
          }
        }
      | undefined
    expect(provider?.additionalProperties?.properties?.options?.properties?.client).toBeDefined()
  },
  { timeout: 30000 },
)

test(
  "schema cli preserves config and optional tui output arguments",
  async () => {
    await using tmp = await tmpdir()
    const cfg = path.join(tmp.path, "config.json")
    const tui = path.join(tmp.path, "tui.json")

    await $`bun ./script/schema.ts ${cfg} ${tui}`.cwd(process.cwd())

    const config = JSON.parse(await fs.readFile(cfg, "utf8")) as {
      properties?: Record<string, { additionalProperties?: unknown }>
    }
    const tuiJson = JSON.parse(await fs.readFile(tui, "utf8")) as { properties?: Record<string, unknown> }

    expect(config.properties?.command?.additionalProperties).toBeDefined()
    expect(config.properties?.agent?.additionalProperties).toBeDefined()
    expect(config.properties?.mode?.additionalProperties).toBeDefined()
    expect(tuiJson.properties).toBeDefined()
  },
  { timeout: 30000 },
)
