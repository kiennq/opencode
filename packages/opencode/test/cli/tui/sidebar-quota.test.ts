import { describe, expect, test } from "bun:test"
import { pickQuota } from "../../../src/cli/cmd/tui/routes/session/sidebar-quota"

describe("pickQuota", () => {
  test("prefers the current selected provider quota over the last assistant provider", () => {
    const quota = pickQuota(
      [
        {
          role: "assistant",
          providerID: "openai",
          tokens: { output: 10 },
        },
      ],
      {
        providerID: "github-copilot",
        modelID: "gpt-5.4",
      },
      {
        openai: { items: [{ label: "OpenAI", remaining: 40, limit: 100 }] },
        "github-copilot": { items: [{ label: "Premium", remaining: 73, limit: 100 }] },
      },
    )

    expect(quota).toEqual({ items: [{ label: "Premium", remaining: 73, limit: 100 }] })
  })

  test("falls back to the last assistant provider quota when no current model exists", () => {
    const quota = pickQuota(
      [
        {
          role: "assistant",
          providerID: "github-copilot",
          tokens: { output: 10 },
        },
      ],
      undefined,
      {
        "github-copilot": { items: [{ label: "Premium", remaining: 73, limit: 100 }] },
      },
    )

    expect(quota).toEqual({ items: [{ label: "Premium", remaining: 73, limit: 100 }] })
  })
})
