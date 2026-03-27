import type { McpStatus, OpencodeClient } from "./client.js"

export async function toggleMcp(client: OpencodeClient, name: string, status?: McpStatus) {
  if (status?.status === "connected") {
    await client.mcp.disconnect({ name })
    return await client.mcp.status()
  }

  if (status?.status === "needs_auth") {
    await client.mcp.auth.authenticate({ name })
    return await client.mcp.status()
  }

  await client.mcp.connect({ name })
  return await client.mcp.status()
}
