import { describe, expect, test } from "bun:test"
import type { UsageEntry } from "../../../src/cli/cmd/tui/component/usage-data"
import {
  usageFailureBackoffMs,
  usageRefreshCooldownMs,
  usageRemember,
  usageShouldRefresh,
  usageShownMax,
  usageWarning,
  usageWarningKey,
} from "../../../src/cli/cmd/tui/component/usage-toast"

function entry(input: {
  provider?: string
  primary?: number | null
  secondary?: number | null
  tertiary?: number | null
}): UsageEntry {
  const window = (value: number | null | undefined) => {
    if (value === null || value === undefined) return null
    return {
      usedPercent: value,
      windowMinutes: 60,
      resetsAt: 1_700_000_000,
    }
  }

  return {
    provider: input.provider ?? "openai",
    displayName: "OpenAI",
    snapshot: {
      primary: window(input.primary),
      secondary: window(input.secondary),
      tertiary: window(input.tertiary),
      credits: null,
      planType: null,
      updatedAt: Date.now(),
    },
  }
}

describe("usage toast", () => {
  test("detects threshold crossings", () => {
    const current = entry({ primary: 80 })
    const previous = entry({ primary: 79 }).snapshot
    const warning = usageWarning(current, previous)
    expect(warning?.window).toBe("primary")
    expect(warning?.threshold).toBe(80)
  })

  test("returns null when no new threshold is crossed", () => {
    const current = entry({ primary: 89 })
    const previous = entry({ primary: 85 }).snapshot
    expect(usageWarning(current, previous)).toBeNull()
  })

  test("prefers stronger threshold across windows", () => {
    const current = entry({ primary: 82, secondary: 91 })
    const previous = entry({ primary: 79, secondary: 89 }).snapshot
    const warning = usageWarning(current, previous)
    expect(warning?.window).toBe("secondary")
    expect(warning?.threshold).toBe(90)
  })

  test("prefers larger usage percent for equal threshold", () => {
    const current = entry({ primary: 82, secondary: 88 })
    const previous = entry({ primary: 79, secondary: 79 }).snapshot
    const warning = usageWarning(current, previous)
    expect(warning?.window).toBe("secondary")
    expect(warning?.threshold).toBe(80)
  })

  test("sanitizes non-finite and out-of-range usage values", () => {
    const invalid = usageWarning(entry({ primary: Number.NaN }), entry({ primary: 79 }).snapshot)
    expect(invalid).toBeNull()

    const high = usageWarning(entry({ primary: 150 }), entry({ primary: 79 }).snapshot)
    expect(high?.threshold).toBe(95)
    expect(high?.usedPercent).toBe(100)
  })

  test("checks refresh cooldown and failure backoff", () => {
    const now = 1_000_000
    expect(
      usageShouldRefresh({
        now,
        successAt: 0,
        failureAt: 0,
        refreshing: true,
      }),
    ).toBeFalse()

    expect(
      usageShouldRefresh({
        now,
        successAt: now - usageRefreshCooldownMs + 1,
        failureAt: 0,
        refreshing: false,
      }),
    ).toBeFalse()

    expect(
      usageShouldRefresh({
        now,
        successAt: 0,
        failureAt: now - usageFailureBackoffMs + 1,
        refreshing: false,
      }),
    ).toBeFalse()

    expect(
      usageShouldRefresh({
        now,
        successAt: now - usageRefreshCooldownMs - 1,
        failureAt: now - usageFailureBackoffMs - 1,
        refreshing: false,
      }),
    ).toBeTrue()
  })

  test("dedupes and evicts oldest key when full", () => {
    const shown = new Set<string>()
    const first = usageWarningKey("openai", {
      window: "primary",
      threshold: 80,
      usedPercent: 80,
      resetsAt: 1,
      windowMinutes: 60,
    })

    expect(usageRemember(shown, first)).toBeTrue()
    expect(usageRemember(shown, first)).toBeFalse()

    for (let index = 1; index < usageShownMax; index++) {
      usageRemember(
        shown,
        usageWarningKey("openai", {
          window: "primary",
          threshold: 80,
          usedPercent: 80 + index,
          resetsAt: index + 1,
          windowMinutes: 60,
        }),
      )
    }

    expect(shown.size).toBe(usageShownMax)
    expect(shown.has(first)).toBeTrue()

    const next = usageWarningKey("openai", {
      window: "secondary",
      threshold: 90,
      usedPercent: 90,
      resetsAt: 9_999,
      windowMinutes: 60,
    })
    expect(usageRemember(shown, next)).toBeTrue()
    expect(shown.size).toBe(usageShownMax)
    expect(shown.has(first)).toBeFalse()
    expect(shown.has(next)).toBeTrue()
  })
})
