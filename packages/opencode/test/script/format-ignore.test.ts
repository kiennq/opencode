import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"

test("ignores custom element pointer files during format", async () => {
  const file = path.resolve(import.meta.dir, "../../../../.prettierignore")
  const text = await fs.readFile(file, "utf8")

  expect(text).toContain("config.json")
  expect(text).toContain("packages/app/src/custom-elements.d.ts")
  expect(text).toContain("packages/enterprise/src/custom-elements.d.ts")
})
