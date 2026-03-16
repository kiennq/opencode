import { describe, expect, test } from "bun:test"
import {
  formatCreditsLabel,
  formatUsageSlotLabel,
  formatUsageWindowLabel,
  usageBarString,
  usageDisplay,
} from "../../../src/cli/cmd/tui/component/usage-format"

describe("usage format", () => {
  test("returns used mode percent and label", () => {
    const result = usageDisplay(64.2, "used")
    expect(result).toEqual({
      percent: 64.2,
      label: "used",
    })
  })

  test("returns remaining mode percent and label", () => {
    const result = usageDisplay(64.2, "remaining")
    expect(result).toEqual({
      percent: 35.8,
      label: "remaining",
    })
  })

  test("clamps invalid values before used/remaining conversion", () => {
    expect(usageDisplay(-10, "used").percent).toBe(0)
    expect(usageDisplay(250, "used").percent).toBe(100)
    expect(usageDisplay(Number.NaN, "used").percent).toBe(0)
    expect(usageDisplay(250, "remaining").percent).toBe(0)
  })

  test("clamps usage bar rendering", () => {
    expect(usageBarString(250, 10)).toBe("██████████")
    expect(usageBarString(-10, 10)).toBe("░░░░░░░░░░")
  })

  test("labels providers explicitly", () => {
    expect(formatUsageWindowLabel("openai", "primary", null)).toBe("5h")
    expect(formatUsageWindowLabel("openai", "secondary", null)).toBe("Weekly")
    expect(formatUsageWindowLabel("anthropic", "primary", null)).toBe("5h")
    expect(formatUsageWindowLabel("anthropic", "secondary", null)).toBe("Weekly")
    expect(formatUsageWindowLabel("github-copilot", "primary", null)).toBe("Monthly")
    expect(formatUsageSlotLabel("github-copilot", "secondary")).toBe("Premium Requests")
  })

  test("formats copilot quota for remaining mode", () => {
    expect(
      formatCreditsLabel(
        "github-copilot",
        {
          hasCredits: true,
          unlimited: false,
          balance: "73",
          total: 300,
          used: 247,
          remaining: 53,
        },
        { mode: "remaining" },
      ),
    ).toBe("Premium Requests Remaining: 53")
  })

  test("formats copilot quota for used mode", () => {
    expect(
      formatCreditsLabel(
        "github-copilot",
        {
          hasCredits: true,
          unlimited: false,
          balance: "73",
          total: 300,
          used: 247,
          remaining: 53,
        },
        { mode: "used" },
      ),
    ).toBe("Premium Requests Used: 247")
  })

  test("formats copilot used mode without counts as unknown", () => {
    expect(
      formatCreditsLabel(
        "github-copilot",
        {
          hasCredits: true,
          unlimited: false,
          balance: "73",
        },
        { mode: "used" },
      ),
    ).toBe("Premium Requests Used: Unknown")
  })
})
