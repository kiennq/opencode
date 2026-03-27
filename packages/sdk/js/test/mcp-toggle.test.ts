import { describe, expect, test } from "bun:test"
import { toggleMcp } from "../src/v2/mcp-toggle.js"

function client() {
  const calls: string[] = []
  return {
    calls,
    value: {
      mcp: {
        async connect({ name }: { name: string }) {
          calls.push(`connect:${name}`)
        },
        async disconnect({ name }: { name: string }) {
          calls.push(`disconnect:${name}`)
        },
        async status() {
          calls.push("status")
          return { data: { demo: { status: "connected" } } }
        },
        auth: {
          async authenticate({ name }: { name: string }) {
            calls.push(`authenticate:${name}`)
          },
        },
      },
    },
  }
}

describe("toggleMcp", () => {
  test("disconnects connected servers", async () => {
    const sdk = client()
    await toggleMcp(sdk.value as any, "demo", { status: "connected" })
    expect(sdk.calls).toEqual(["disconnect:demo", "status"])
  })

  test("authenticates needs_auth servers before refreshing status", async () => {
    const sdk = client()
    await toggleMcp(sdk.value as any, "demo", { status: "needs_auth" })
    expect(sdk.calls).toEqual(["authenticate:demo", "status"])
  })

  test("connects all other server states", async () => {
    const sdk = client()
    await toggleMcp(sdk.value as any, "demo", { status: "disabled" })
    expect(sdk.calls).toEqual(["connect:demo", "status"])
  })
})
