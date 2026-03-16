import { expect, test } from "bun:test"

test("imports skill module", async () => {
  const mod = await import("../../src/skill")
  expect(mod.Skill).toBeDefined()
})
