import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"

afterEach(async () => {
  await Instance.disposeAll()
})

async function isolated<T>(fn: () => Promise<T>) {
  const project = process.env.OPENCODE_DISABLE_PROJECT_CONFIG
  const plugins = process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS

  process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "true"
  process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "true"

  try {
    return await fn()
  } finally {
    if (project === undefined) delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
    else process.env.OPENCODE_DISABLE_PROJECT_CONFIG = project

    if (plugins === undefined) delete process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
    else process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = plugins
  }
}

let plugins: string | undefined

beforeEach(() => {
  plugins = process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
  process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "true"
})

afterEach(() => {
  if (plugins === undefined) delete process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
  else process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = plugins
})
describe("tool.registry", () => {
  test("loads tools from .opencode/tool (singular)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const opencodeDir = path.join(dir, ".opencode")
        await fs.mkdir(opencodeDir, { recursive: true })

        const toolDir = path.join(opencodeDir, "tool")
        await fs.mkdir(toolDir, { recursive: true })

        await Bun.write(
          path.join(toolDir, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("hello")
      },
    })
  })

  test("loads tools from .opencode/tools (plural)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const opencodeDir = path.join(dir, ".opencode")
        await fs.mkdir(opencodeDir, { recursive: true })

        const toolsDir = path.join(opencodeDir, "tools")
        await fs.mkdir(toolsDir, { recursive: true })

        await Bun.write(
          path.join(toolsDir, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("hello")
      },
    })
  })

  test(
    "loads tools with external dependencies without crashing",
    async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const opencodeDir = path.join(dir, ".opencode")
          await fs.mkdir(opencodeDir, { recursive: true })

          const toolsDir = path.join(opencodeDir, "tools")
          await fs.mkdir(toolsDir, { recursive: true })

          await Bun.write(
            path.join(opencodeDir, "package.json"),
            JSON.stringify({
              name: "custom-tools",
              dependencies: {
                "@opencode-ai/plugin": "^0.0.0",
                cowsay: "^1.6.0",
              },
            }),
          )

          await Bun.write(
            path.join(toolsDir, "cowsay.ts"),
            [
              "import { say } from 'cowsay'",
              "export default {",
              "  description: 'tool that imports cowsay at top level',",
              "  args: { text: { type: 'string' } },",
              "  execute: async ({ text }: { text: string }) => {",
              "    return say({ text })",
              "  },",
              "}",
              "",
            ].join("\n"),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const ids = await ToolRegistry.ids()
          expect(ids).toContain("cowsay")
        },
      })
    },
    { timeout: 30000 },
  )

  test("does not expose a separate pwsh tool", async () => {
    await using tmp = await tmpdir()

    await isolated(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const ids = await ToolRegistry.ids()
          expect(ids).not.toContain("pwsh")
        },
      }),
    )
  })
})
