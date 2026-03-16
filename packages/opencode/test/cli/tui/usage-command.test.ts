import { describe, expect, test } from "bun:test"
import { parseUsageCommand } from "../../../src/usage/command"

describe("usage command", () => {
  test("uses config defaults when flags are omitted", () => {
    const result = parseUsageCommand("/usage", {
      show_usage_provider_scope: "all",
      show_usage_value_mode: "remaining",
    })
    if ("error" in result) throw new Error(result.error)
    expect(result).toEqual({
      provider: undefined,
      scope: "all",
      mode: "remaining",
    })
  })

  test("parses provider with mode override", () => {
    const result = parseUsageCommand("/usage openai --remaining")
    if ("error" in result) throw new Error(result.error)
    expect(result).toEqual({
      provider: "openai",
      scope: "current",
      mode: "remaining",
    })
  })

  test("drops provider when scope flag is explicit", () => {
    const result = parseUsageCommand("/usage openai --all")
    if ("error" in result) throw new Error(result.error)
    expect(result).toEqual({
      provider: undefined,
      scope: "all",
      mode: "used",
    })
  })

  test("rejects conflicting scope flags", () => {
    const result = parseUsageCommand("/usage --all --current")
    expect(result).toEqual({
      error: "Choose only one of --all or --current.",
    })
  })

  test("rejects conflicting mode flags", () => {
    const result = parseUsageCommand("/usage --used --remaining")
    expect(result).toEqual({
      error: "Choose only one of --used or --remaining.",
    })
  })
})
