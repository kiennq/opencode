import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("config.reload", () => {
  test("reloads configuration successfully", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()

        const response = await app.request("/config/reload", {
          method: "POST",
        })
        expect(response.status).toBe(200)

        const body = (await response.json()) as { success: boolean }
        expect(body.success).toBe(true)
      },
    })
  })

  test("reload endpoint exists", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()

        const response = await app.request("/config/reload", {
          method: "POST",
        })

        expect(response.status).not.toBe(404)
      },
    })
  })

  test("reload does not fail when no active sessions", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})

        // Session starts idle
        const statusBefore = SessionStatus.get(session.id)
        expect(statusBefore?.type).toBe("idle")

        const app = Server.App()
        const response = await app.request("/config/reload", {
          method: "POST",
        })
        expect(response.status).toBe(200)

        await Session.remove(session.id)
      },
    })
  })
})

describe("SessionPrompt.cancel", () => {
  test("cancel on non-existent session does not throw", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        // Should not throw for non-existent session
        expect(() => {
          SessionPrompt.cancel("non-existent-session-id", MessageV2.ABORT_REASON.CONFIG_RELOAD)
        }).not.toThrow()
      },
    })
  })

  test("cancel with reason is accepted", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})

        // Cancel with reason should not throw even if session isn't actively prompting
        expect(() => {
          SessionPrompt.cancel(session.id, MessageV2.ABORT_REASON.CONFIG_RELOAD)
        }).not.toThrow()

        await Session.remove(session.id)
      },
    })
  })

  test("cancel without reason is accepted", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})

        // Cancel without reason (simulates user Escape) should not throw
        expect(() => {
          SessionPrompt.cancel(session.id)
        }).not.toThrow()

        await Session.remove(session.id)
      },
    })
  })
})

describe("incomplete message cleanup on reload", () => {
  test("incomplete assistant message gets time.completed after disposal", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        // Create a session with an incomplete assistant message (simulates abort during streaming)
        const session = await Session.create({})

        // Create a user message first
        const userMsg: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "coder",
          model: { providerID: "test", modelID: "test" },
        }
        await Session.updateMessage(userMsg)

        // Create an incomplete assistant message (no time.completed)
        const assistantMsg: MessageV2.Assistant = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          parentID: userMsg.id,
          role: "assistant",
          mode: "coder",
          agent: "coder",
          cost: 0,
          path: { cwd: projectRoot, root: projectRoot },
          time: { created: Date.now() }, // Note: no 'completed' field!
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "test",
          providerID: "test",
        }
        await Session.updateMessage(assistantMsg)

        // Verify the message is incomplete before reload
        const msgsBefore = await Session.messages({ sessionID: session.id })
        const incompleteBefore = msgsBefore.find((m) => m.info.role === "assistant" && !m.info.time.completed)
        expect(incompleteBefore).toBeDefined()

        // Trigger reload - this should complete any incomplete messages
        const app = Server.App()
        await app.request("/config/reload", { method: "POST" })

        // After reload, the incomplete assistant message should now have time.completed
        const msgsAfter = await Session.messages({ sessionID: session.id })
        const incompleteAfter = msgsAfter.find((m) => m.info.role === "assistant" && !m.info.time.completed)

        // This is the key assertion: no incomplete assistant messages after reload
        expect(incompleteAfter).toBeUndefined()

        await Session.remove(session.id)
      },
    })
  })
})

describe("abort reason persistence", () => {
  test("incomplete assistant message gets config-reload reason after reload", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        // Create a session with an incomplete assistant message (simulates abort during streaming)
        const session = await Session.create({})

        // Create a user message first
        const userMsg: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "coder",
          model: { providerID: "test", modelID: "test" },
        }
        await Session.updateMessage(userMsg)

        // Create an incomplete assistant message (no time.completed, no error)
        const assistantMsg: MessageV2.Assistant = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          parentID: userMsg.id,
          role: "assistant",
          mode: "coder",
          agent: "coder",
          cost: 0,
          path: { cwd: projectRoot, root: projectRoot },
          time: { created: Date.now() },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "test",
          providerID: "test",
        }
        await Session.updateMessage(assistantMsg)

        // Trigger reload - this should complete incomplete messages with config-reload reason
        const app = Server.App()
        await app.request("/config/reload", { method: "POST" })

        // After reload, the assistant message should have the abort error with reason
        const msgsAfter = await Session.messages({ sessionID: session.id })
        const assistantAfter = msgsAfter.find((m) => m.info.id === assistantMsg.id)

        expect(assistantAfter).toBeDefined()
        expect(assistantAfter!.info.role).toBe("assistant")
        const info = assistantAfter!.info as MessageV2.Assistant
        expect(info.time.completed).toBeDefined()
        expect(info.error).toBeDefined()
        expect(info.error?.name).toBe("MessageAbortedError")
        expect((info.error?.data as { reason?: string })?.reason).toBe(MessageV2.ABORT_REASON.CONFIG_RELOAD)

        await Session.remove(session.id)
      },
    })
  })
})

describe("MessageV2.fromError abort handling", () => {
  test("string error creates AbortedError with reason", async () => {
    const { MessageV2 } = await import("../../src/session/message-v2")

    // When AbortController.abort(reason) is called with a string,
    // the thrown error is the string itself
    const error = MessageV2.fromError(MessageV2.ABORT_REASON.CONFIG_RELOAD, { providerID: "test" })

    expect(error.name).toBe("MessageAbortedError")
    expect((error.data as { reason?: string }).reason).toBe(MessageV2.ABORT_REASON.CONFIG_RELOAD)
    expect((error.data as { message: string }).message).toBe("The operation was aborted")
  })

  test("DOMException AbortError with signal reason creates AbortedError with reason", async () => {
    const { MessageV2 } = await import("../../src/session/message-v2")

    // Create an abort controller and abort with reason
    const ac = new AbortController()
    ac.abort(MessageV2.ABORT_REASON.CONFIG_RELOAD)

    // The DOMException itself doesn't have the reason, but the signal does
    const domException = new DOMException("The operation was aborted", "AbortError")
    const error = MessageV2.fromError(domException, {
      providerID: "test",
      abortSignal: ac.signal,
    })

    expect(error.name).toBe("MessageAbortedError")
    expect((error.data as { message: string }).message).toBe("The operation was aborted")
    expect((error.data as { reason?: string }).reason).toBe(MessageV2.ABORT_REASON.CONFIG_RELOAD)
  })

  test("DOMException AbortError without signal has undefined reason", async () => {
    const { MessageV2 } = await import("../../src/session/message-v2")

    // User presses Escape - abort without reason
    const domException = new DOMException("The operation was aborted", "AbortError")
    const error = MessageV2.fromError(domException, { providerID: "test" })

    expect(error.name).toBe("MessageAbortedError")
    expect((error.data as { reason?: string }).reason).toBeUndefined()
  })

  test("user abort without reason has undefined reason", async () => {
    const { MessageV2 } = await import("../../src/session/message-v2")

    // User presses Escape - abort without passing a reason
    const ac = new AbortController()
    ac.abort() // No reason

    const domException = new DOMException("The operation was aborted", "AbortError")
    const error = MessageV2.fromError(domException, {
      providerID: "test",
      abortSignal: ac.signal,
    })

    expect(error.name).toBe("MessageAbortedError")
    expect((error.data as { reason?: string }).reason).toBeUndefined()
  })
})
