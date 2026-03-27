import { afterEach, describe, expect, test } from "bun:test"
import { GlobalBus } from "../../src/bus/global"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
})

describe("instance.reload endpoint", () => {
  test("deeptest: reload endpoint emits disposed event so clients can refresh", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()
    const seen: { directory?: string; payload: { type: string } }[] = []
    const fn = (evt: { directory?: string; payload: { type: string } }) => {
      seen.push(evt)
    }
    GlobalBus.on("event", fn)

    try {
      const warm = await app.request("/path", {
        headers: {
          "x-opencode-directory": tmp.path,
        },
      })
      expect(warm.status).toBe(200)

      // deeptest: /instance/reload should mirror the existing disposal event
      // behavior so TUI/server clients can refresh live state after a reload.
      // Suggested fix: add the route near /instance/dispose and call Instance.reload().
      const response = await app.request("/instance/reload", {
        method: "POST",
        headers: {
          "x-opencode-directory": tmp.path,
        },
      })

      expect(response.status).toBe(200)
      expect(seen.some((evt) => evt.directory === tmp.path && evt.payload.type === "server.instance.disposed")).toBe(
        true,
      )
    } finally {
      GlobalBus.off("event", fn)
    }
  })
})
