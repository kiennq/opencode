export function format() {
  return ["bun", "./script/format.ts"] as const
}

export function schema() {
  return ["bun", "./packages/opencode/script/schema.ts", "./config.json"] as const
}
