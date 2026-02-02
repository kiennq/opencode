import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { ulid } from "ulid"
import { Provider } from "@/provider/provider"
import { Instance } from "@/project/instance"
import { instanceState } from "@/project/instance-state"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { Storage } from "@/storage/storage"
import { Log } from "@/util/log"
import type * as SDK from "@opencode-ai/sdk/v2"

export namespace ShareNext {
  const log = Log.create({ service: "share-next" })

  async function url() {
    return Config.get().then((x) => x.enterprise?.url ?? "https://opncd.ai")
  }

  const disabled = process.env["OPENCODE_DISABLE_SHARE"] === "true" || process.env["OPENCODE_DISABLE_SHARE"] === "1"

  const state = instanceState(
    async () => {
      if (disabled)
        return { unsubs: [], queue: new Map<string, { timeout: NodeJS.Timeout; data: Map<string, Data> }>() }

      const unsubs: Array<() => void> = []
      const queue = new Map<string, { timeout: NodeJS.Timeout; data: Map<string, Data> }>()

      unsubs.push(
        Bus.subscribe(Session.Event.Updated, async (evt) => {
          await sync(queue, evt.properties.info.id, [
            {
              type: "session",
              data: evt.properties.info,
            },
          ])
        }),
      )
      unsubs.push(
        Bus.subscribe(MessageV2.Event.Updated, async (evt) => {
          await sync(queue, evt.properties.info.sessionID, [
            {
              type: "message",
              data: evt.properties.info,
            },
          ])
          if (evt.properties.info.role === "user") {
            await sync(queue, evt.properties.info.sessionID, [
              {
                type: "model",
                data: [
                  await Provider.getModel(evt.properties.info.model.providerID, evt.properties.info.model.modelID).then(
                    (m) => m,
                  ),
                ],
              },
            ])
          }
        }),
      )
      unsubs.push(
        Bus.subscribe(MessageV2.Event.PartUpdated, async (evt) => {
          await sync(queue, evt.properties.part.sessionID, [
            {
              type: "part",
              data: evt.properties.part,
            },
          ])
        }),
      )
      unsubs.push(
        Bus.subscribe(Session.Event.Diff, async (evt) => {
          await sync(queue, evt.properties.sessionID, [
            {
              type: "session_diff",
              data: evt.properties.diff,
            },
          ])
        }),
      )

      return { unsubs, queue }
    },
    async (s) => {
      for (const unsub of s.unsubs) {
        unsub()
      }
      // Clear any pending timeouts
      for (const entry of s.queue.values()) {
        clearTimeout(entry.timeout)
      }
      s.queue.clear()
    },
  )

  export async function init() {
    state()
  }

  export async function create(sessionID: string) {
    if (disabled) return { id: "", url: "", secret: "" }
    log.info("creating share", { sessionID })
    const result = await fetch(`${await url()}/api/share`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionID: sessionID }),
    })
      .then((x) => x.json())
      .then((x) => x as { id: string; url: string; secret: string })
    await Storage.write(["session_share", sessionID], result)
    fullSync(sessionID)
    return result
  }

  function get(sessionID: string) {
    return Storage.read<{
      id: string
      secret: string
      url: string
    }>(["session_share", sessionID])
  }

  type Data =
    | {
        type: "session"
        data: SDK.Session
      }
    | {
        type: "message"
        data: SDK.Message
      }
    | {
        type: "part"
        data: SDK.Part
      }
    | {
        type: "session_diff"
        data: SDK.FileDiff[]
      }
    | {
        type: "model"
        data: SDK.Model[]
      }

  const queue = new Map<string, { timeout: NodeJS.Timeout; data: Map<string, Data> }>()
  async function sync(
    syncQueue: Map<string, { timeout: NodeJS.Timeout; data: Map<string, Data> }>,
    sessionID: string,
    data: Data[],
  ) {
    if (disabled) return
    const existing = syncQueue.get(sessionID)
    if (existing) {
      for (const item of data) {
        existing.data.set("id" in item ? (item.id as string) : ulid(), item)
      }
      return
    }

    const dataMap = new Map<string, Data>()
    for (const item of data) {
      dataMap.set("id" in item ? (item.id as string) : ulid(), item)
    }

    const timeout = setTimeout(async () => {
      const queued = syncQueue.get(sessionID)
      if (!queued) return
      syncQueue.delete(sessionID)
      const share = await get(sessionID).catch(() => undefined)
      if (!share) return

      await fetch(`${await url()}/api/share/${share.id}/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          secret: share.secret,
          data: Array.from(queued.data.values()),
        }),
      })
    }, 1000)
    syncQueue.set(sessionID, { timeout, data: dataMap })
  }

  export async function remove(sessionID: string) {
    if (disabled) return
    log.info("removing share", { sessionID })
    const share = await get(sessionID)
    if (!share) return
    await fetch(`${await url()}/api/share/${share.id}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        secret: share.secret,
      }),
    })
    await Storage.remove(["session_share", sessionID])
  }

  async function fullSync(sessionID: string) {
    log.info("full sync", { sessionID })
    const s = await state()
    const session = await Session.get(sessionID)
    const diffs = await Session.diff(sessionID)
    const messages = await Array.fromAsync(MessageV2.stream(sessionID))
    const models = await Promise.all(
      messages
        .filter((m) => m.info.role === "user")
        .map((m) => (m.info as SDK.UserMessage).model)
        .map((m) => Provider.getModel(m.providerID, m.modelID).then((m) => m)),
    )
    await sync(s.queue, sessionID, [
      {
        type: "session",
        data: session,
      },
      ...messages.map((x) => ({
        type: "message" as const,
        data: x.info,
      })),
      ...messages.flatMap((x) => x.parts.map((y) => ({ type: "part" as const, data: y }))),
      {
        type: "session_diff",
        data: diffs,
      },
      {
        type: "model",
        data: models,
      },
    ])
  }
}
