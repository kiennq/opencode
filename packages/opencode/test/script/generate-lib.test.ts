import { expect, test } from "bun:test"
import { format } from "../../../../script/generate-lib"

test("runs the format script through bun", () => {
  expect(format()).toEqual(["bun", "./script/format.ts"])
})
