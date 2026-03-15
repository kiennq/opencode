import { describe, expect, test } from "bun:test"
import { Auth } from "../../src/auth"

describe("copilot usage auth", () => {
  test("oauth auth keeps optional usage token", async () => {
    await Auth.set("github-copilot", {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      usage: "usage-token",
      expires: 0,
    })

    const auth = await Auth.get("github-copilot")
    expect(auth?.type).toBe("oauth")
    if (!auth || auth.type !== "oauth") throw new Error("expected oauth auth")
    expect(auth.usage).toBe("usage-token")
  })

  test("oauth auth keeps missing usage token optional", async () => {
    await Auth.set("github-copilot", {
      type: "oauth",
      access: "",
      refresh: "refresh-token",
      expires: 0,
    })

    const auth = await Auth.get("github-copilot")
    expect(auth?.type).toBe("oauth")
    if (!auth || auth.type !== "oauth") throw new Error("expected oauth auth")
    expect(auth.refresh).toBe("refresh-token")
    expect(auth.usage).toBeUndefined()
  })
})
