import { Log } from "../util/log"
import { Bus } from "../bus"
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { SessionStatus } from "../session/status"
import { MessageID, PartID, SessionID } from "../session/schema"
import { ModelID, ProviderID } from "../provider/schema"
import { Team, TeamEvent } from "./index"
import { Inbox } from "./inbox"

const log = Log.create({ service: "team.messaging" })
const MAX_TEXT = 10 * 1024

function validateText(text: string) {
  if (text.length <= MAX_TEXT) return
  throw new Error(`Team message too large (${text.length} chars). Maximum is ${MAX_TEXT} chars.`)
}

function messageId(): string {
  return `im_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export namespace TeamMessaging {
  /**
   * Send a message from one team member to another.
   * Writes to the recipient's inbox (source of truth), then injects
   * a synthetic user message into their session (delivery mechanism),
   * then auto-wakes if idle.
   */
  export async function send(input: { teamName: string; from: string; to: string; text: string }): Promise<void> {
    validateText(input.text)
    const team = await Team.get(input.teamName)
    if (!team) throw new Error(`Team "${input.teamName}" not found`)

    // Find recipient session
    let targetSessionID: string | undefined
    if (input.to === "lead") {
      targetSessionID = team.leadSessionID
    } else {
      const member = team.members.find((m) => m.name === input.to)
      if (!member) throw new Error(`Member "${input.to}" not found in team "${input.teamName}"`)
      if (member.status === "shutdown") throw new Error(`Member "${input.to}" has shut down`)
      targetSessionID = member.sessionID
    }

    if (!targetSessionID) throw new Error(`Could not find session for "${input.to}"`)
    const sessionID = SessionID.make(targetSessionID)

    // Write to inbox (source of truth)
    const inboxId = messageId()
    await Inbox.write(input.teamName, input.to, {
      id: inboxId,
      from: input.from,
      text: input.text,
      timestamp: Date.now(),
    })

    // Inject into session (delivery mechanism), tagged with inbox ID for dedup
    await injectMessage(sessionID, input.from, input.text, inboxId)

    log.info("message sent", { teamName: input.teamName, from: input.from, to: input.to })
    await Bus.publish(TeamEvent.Message, {
      teamName: input.teamName,
      from: input.from,
      to: input.to,
      text: input.text,
    })

    // Auto-wake: if the recipient session is idle, start its prompt loop
    // so the LLM processes the injected message.
    autoWake(sessionID, input.from)
  }

  /**
   * Broadcast a message from one member to all other members.
   */
  export async function broadcast(input: { teamName: string; from: string; text: string }): Promise<void> {
    validateText(input.text)
    const team = await Team.get(input.teamName)
    if (!team) throw new Error(`Team "${input.teamName}" not found`)

    // Send to all active members except the sender
    const memberTargets = team.members
      .filter((m) => m.name !== input.from && m.status !== "shutdown")
      .map((m) => ({ name: m.name, sessionID: SessionID.make(m.sessionID) }))

    const targets =
      input.from !== "lead" && team.leadSessionID
        ? [{ name: "lead", sessionID: SessionID.make(team.leadSessionID) }, ...memberTargets]
        : memberTargets

    const errors: Array<{ target: string; phase: string; error: string }> = []
    for (const target of targets) {
      const inboxId = messageId()

      // Write to inbox (source of truth)
      const wrote = await Inbox.write(input.teamName, target.name, {
        id: inboxId,
        from: input.from,
        text: input.text,
        timestamp: Date.now(),
      }).then(
        () => true,
        (err) => {
          const msg = err instanceof Error ? err.message : String(err)
          log.warn("broadcast inbox write failed", { target: target.name, error: msg })
          errors.push({ target: target.name, phase: "inbox", error: msg })
          return false
        },
      )

      // Only inject if inbox write succeeded — no point delivering a message
      // that won't survive recovery
      if (wrote) {
        await injectMessage(target.sessionID, input.from, input.text, inboxId).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err)
          log.warn("broadcast inject failed", { target: target.name, error: msg })
          errors.push({ target: target.name, phase: "inject", error: msg })
        })
      }
    }

    const delivered = targets.length - errors.filter((e) => e.phase === "inbox").length
    log.info("broadcast sent", {
      teamName: input.teamName,
      from: input.from,
      targets: targets.length,
      delivered,
      errors: errors.length,
    })
    if (errors.length > 0) log.warn("broadcast partial failure", { teamName: input.teamName, errors })

    await Bus.publish(TeamEvent.Broadcast, {
      teamName: input.teamName,
      from: input.from,
      text: input.text,
    })

    // Auto-wake all idle recipient sessions
    for (const target of targets) {
      autoWake(target.sessionID, input.from)
    }
  }

  /**
   * Mark all messages as read in an agent's inbox, then send
   * delivery receipts back to each sender. Receipts are batched
   * per sender and flow through the same inbox + inject + auto-wake
   * path as regular team messages.
   */
  export async function markRead(teamName: string, agentName: string): Promise<number> {
    const read = await Inbox.markRead(teamName, agentName)
    if (read.length === 0) return 0

    // Group by sender for batched receipts
    const bySender = new Map<string, number>()
    for (const msg of read) {
      bySender.set(msg.from, (bySender.get(msg.from) ?? 0) + 1)
    }

    // Send a receipt to each distinct sender
    const team = await Team.get(teamName)
    if (team) {
      for (const [sender, count] of bySender) {
        // Find sender's session
        let senderSessionID: string | undefined
        if (sender === "lead") {
          senderSessionID = team.leadSessionID
        } else {
          const member = team.members.find((m) => m.name === sender)
          if (member && member.status !== "shutdown") senderSessionID = member.sessionID
        }
        if (!senderSessionID) continue
        const sessionID = SessionID.make(senderSessionID)

        const text = count === 1 ? `${agentName} has read your message` : `${agentName} has read your ${count} messages`

        const receiptId = messageId()
        await Inbox.write(teamName, sender, {
          id: receiptId,
          from: agentName,
          text: `[receipt] ${text}`,
          timestamp: Date.now(),
        }).catch((err: unknown) => {
          log.warn("receipt inbox write failed", {
            teamName,
            sender,
            error: err instanceof Error ? err.message : String(err),
          })
        })

        await injectMessage(sessionID, agentName, `[receipt] ${text}`, receiptId).catch((err: unknown) => {
          log.warn("receipt inject failed", {
            teamName,
            sender,
            error: err instanceof Error ? err.message : String(err),
          })
        })

        autoWake(sessionID, agentName)
      }
      log.info("delivery receipts sent", { teamName, from: agentName, senders: [...bySender.keys()] })
    }

    return read.length
  }

  /**
   * Reinject unread inbox messages that were never delivered to the session.
   * Deduplicates by inboxMessageId stored in part metadata.
   * Returns the number of messages reinjected.
   */
  export async function recoverInbox(teamName: string, agentName: string, sessionID: SessionID): Promise<number> {
    const pending = await Inbox.unread(teamName, agentName)
    if (pending.length === 0) return 0

    // Find inbox message IDs already present in the session
    const msgs = await Session.messages({ sessionID })
    const delivered = new Set<string>()
    for (const msg of msgs) {
      for (const part of msg.parts) {
        const meta = (part as { metadata?: Record<string, unknown> }).metadata
        if (meta?.inboxMessageId) delivered.add(meta.inboxMessageId as string)
      }
    }

    let count = 0
    for (const msg of pending) {
      if (delivered.has(msg.id)) continue
      await injectMessage(sessionID, msg.from, msg.text, msg.id)
      count++
    }

    if (count > 0)
      log.info("inbox recovery", { teamName, agentName, reinjected: count, skipped: pending.length - count })
    return count
  }

  /**
   * Auto-wake an idle session after a team message is injected.
   * If the session is idle (no active prompt loop), starts a new loop
   * so the LLM picks up and processes the injected message.
   */
  async function autoWake(sessionID: SessionID, from: string) {
    try {
      const status = SessionStatus.get(sessionID)
      if (status.type !== "idle") return
      let member:
        | {
            teamName: string
            memberName: string
          }
        | undefined
      // Don't wake a teammate that's fully shut down.
      // We DO wake for shutdown_requested — the teammate needs to process
      // the shutdown message and wrap up. The .then() handler below
      // transitions shutdown_requested → shutdown when the loop ends.
      const info = await Team.findBySession(sessionID)
      if (info && info.role === "member") {
        const current = info.team.members.find((m) => m.name === info.memberName)
        if (current?.status === "shutdown") return
        member = {
          teamName: info.team.name,
          memberName: info.memberName!,
        }
        if (current?.status === "ready" || current?.status === "error") {
          await Team.transitionMemberStatus(info.team.name, info.memberName!, "busy")
        }
        await Team.transitionExecutionStatus(info.team.name, info.memberName!, "starting", { force: true })
      }
      log.info("auto-waking idle session", { sessionID, from })
      const loop = (async () => {
        if (member) {
          await Team.transitionExecutionStatus(member.teamName, member.memberName, "running", { force: true })
        }
        return SessionPrompt.loop({ sessionID })
      })()
      loop
        .then(async () => {
          // When an auto-woken loop ends, check if shutdown was requested.
          // Shutdown is authoritative — the teammate gets one loop to wrap up
          // (summarize findings, send final messages) then transitions to shutdown.
          // Both this handler and the spawn .then() check for shutdown_requested;
          // transitionMemberStatus is idempotent (from === status returns early).
          if (!member) return
          await Team.transitionExecutionStatus(member.teamName, member.memberName, "completing", { force: true })
          await Team.transitionExecutionStatus(member.teamName, member.memberName, "completed", { force: true })
          await Team.transitionExecutionStatus(member.teamName, member.memberName, "idle", { force: true })
          const team = await Team.get(member.teamName)
          const current = team?.members.find((m) => m.name === member.memberName)
          if (current?.status === "shutdown_requested") {
            await Team.transitionMemberStatus(member.teamName, member.memberName, "shutdown")
            log.info("auto-wake loop completed shutdown", { teamName: member.teamName, name: member.memberName })
            return
          }
          if (current?.status === "busy") {
            await Team.transitionMemberStatus(member.teamName, member.memberName, "ready", { force: true })
          }
        })
        .catch((err: unknown) => {
          if (member) {
            void (async () => {
              await Team.transitionExecutionStatus(member.teamName, member.memberName, "failed", { force: true })
              await Team.transitionExecutionStatus(member.teamName, member.memberName, "idle", { force: true })
              const team = await Team.get(member.teamName)
              const current = team?.members.find((m) => m.name === member.memberName)
              if (current?.status === "busy") {
                await Team.transitionMemberStatus(member.teamName, member.memberName, "error", { force: true })
              }
            })().catch(() => {})
          }
          log.warn("auto-wake loop failed", { sessionID, error: err instanceof Error ? err.message : String(err) })
        })
    } catch (err) {
      log.warn("auto-wake failed", { sessionID, error: err instanceof Error ? (err as Error).message : String(err) })
    }
  }

  /**
   * Inject a synthetic user message into a session from a teammate.
   * This is how teammates "receive" messages — as user messages
   * with a TeamMessagePart that the prompt loop will process.
   */
  async function injectMessage(
    sessionID: SessionID,
    fromName: string,
    text: string,
    inboxMessageId?: string,
  ): Promise<void> {
    // Get the session to find the current agent and model
    // Don't limit — we need to find the last user message which may not be the most recent
    const msgs = await Session.messages({ sessionID })
    const lastUser = msgs.findLast((m) => m.info.role === "user")
    if (!lastUser) {
      throw new Error(`No user message found in session ${sessionID}`)
    }
    const userInfo = lastUser.info as { agent: string; model: { providerID: ProviderID; modelID: ModelID } }

    const msgId = MessageID.ascending()
    await Session.updateMessage({
      id: msgId,
      sessionID,
      role: "user",
      agent: userInfo.agent,
      model: userInfo.model,
      time: { created: Date.now() },
    })

    await Session.updatePart({
      id: PartID.ascending(),
      messageID: msgId,
      sessionID,
      type: "text",
      text: `[Team message from ${fromName}]: ${text}`,
      synthetic: true,
      ...(inboxMessageId ? { metadata: { inboxMessageId } } : {}),
    })
  }
}
