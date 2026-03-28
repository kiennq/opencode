import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Instance } from "../../src/project/instance"
import { Plugin } from "../../src/plugin"
import { Skill } from "../../src/skill"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { tmpdir } from "../fixture/fixture"

const disableDefault = process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1"

afterEach(async () => {
  await Instance.disposeAll()
  if (disableDefault === undefined) {
    delete process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
    return
  }
  process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = disableDefault
})

test("plugin-injected skills remain available after instance reload", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skills = path.join(dir, "plugin-skills")
      const skill = path.join(skills, "reload-skill")
      const plugin = path.join(dir, "reload-plugin.ts")
      await fs.mkdir(skill, { recursive: true })
      await Bun.write(
        path.join(skill, "SKILL.md"),
        `---
name: reload-skill
description: Survives reload when injected by plugin config.
---

# Reload skill
`,
      )
      await Bun.write(
        plugin,
        [
          "export default {",
          '  id: "demo.reload.skill",',
          "  server: async () => ({",
          "    config: async (config) => {",
          "      config.skills = config.skills || {}",
          "      config.skills.paths = config.skills.paths || []",
          `      if (!config.skills.paths.includes(${JSON.stringify(skills)})) config.skills.paths.push(${JSON.stringify(skills)})`,
          "    },",
          "  }),",
          "}",
          "",
        ].join("\n"),
      )
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({ plugin: [pathToFileURL(plugin).href] }, null, 2),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect((await Skill.all()).some((item) => item.name === "reload-skill")).toBe(true)
      expect((await Plugin.list()).length).toBeGreaterThan(0)
      await Instance.reload({
        directory: tmp.path,
        project: Instance.project,
        worktree: Instance.worktree,
        init: InstanceBootstrap,
      })
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect((await Skill.all()).some((item) => item.name === "reload-skill")).toBe(true)
    },
  })
})
