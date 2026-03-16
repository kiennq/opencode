import { expect, test } from "bun:test"
import { Flag } from "../../src/flag/flag"

test("OPENCODE_DISABLE_DEFAULT_PLUGINS is read dynamically", () => {
  const prev = process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS

  try {
    delete process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
    expect(Flag.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe(false)

    process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "true"
    expect(Flag.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe(true)

    process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "false"
    expect(Flag.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe(false)
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
    else process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = prev
  }
})
