import { test, expect } from "bun:test"
import { compatVersion, compatTransport } from "../../src/mcp/version.ts"
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"

function next(version: string) {
  const [year, month, day] = version.split("-").map(Number)
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
}

test("compatVersion accepts well-formed older versions and rejects newer or malformed ones", () => {
  expect(compatVersion("2025-11-05")).toBe(true)
  expect(compatVersion("2024-01-01")).toBe(true)
  expect(compatVersion(LATEST_PROTOCOL_VERSION)).toBe(true)
  expect(compatVersion(next(LATEST_PROTOCOL_VERSION))).toBe(false)
  expect(compatVersion("2025-99-99")).toBe(false)
  expect(compatVersion("latest")).toBe(false)
})

test("compatTransport rewrites initialize version for SDK checks and preserves server version on wire", async () => {
  const seen: Array<string> = []
  const sent: Array<string> = []
  const base = {
    onmessage: undefined as (<T extends JSONRPCMessage>(message: T) => void) | undefined,
    async start() {},
    async close() {},
    async send(message: any) {
      sent.push(message.method)
    },
    setProtocolVersion(version: string) {
      seen.push(version)
    },
  }

  const transport = compatTransport(base)
  transport.onmessage = (message) => {
    if (
      "result" in message &&
      message.result &&
      typeof message.result === "object" &&
      "protocolVersion" in message.result
    ) {
      seen.push(String(message.result.protocolVersion))
    }
  }

  await transport.send({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} as any })
  transport.onmessage?.({
    jsonrpc: "2.0",
    id: 7,
    result: {
      protocolVersion: "2025-11-05",
      capabilities: {},
      serverInfo: { name: "bing", version: "1" },
    },
  })
  transport.setProtocolVersion?.(LATEST_PROTOCOL_VERSION)

  expect(sent).toEqual(["initialize"])
  expect(seen).toEqual([LATEST_PROTOCOL_VERSION, "2025-11-05"])
})

test("compatTransport preserves transport methods", async () => {
  let done = false
  class Base {
    async start() {}
    async send() {}
    async close() {}
    async finishAuth() {
      done = true
    }
  }

  const transport = compatTransport(new Base())
  await transport.finishAuth()

  expect(done).toBe(true)
})
