import { expect, test } from "bun:test"
import { format, schema } from "../../../../script/generate-lib"

test("runs the format script through bun", () => {
  expect(format()).toEqual(["bun", "./script/format.ts"])
})

test("runs the config schema generator through the shared schema cli", () => {
  expect(schema()).toEqual(["bun", "./packages/opencode/script/schema.ts", "./config.json"])
})
