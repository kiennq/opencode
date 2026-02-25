import { createMemo, createSignal, onMount } from "solid-js"
import { produce } from "solid-js/store"
import { useSync } from "@tui/context/sync"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import type { Message, TextPart } from "@opencode-ai/sdk/v2"
import { useTheme } from "@tui/context/theme"
import { Locale } from "@/util/locale"
import { DialogMessage } from "./dialog-message"
import { useDialog } from "../../ui/dialog"
import type { PromptInfo } from "../../component/prompt/history"
import { useSDK } from "@tui/context/sdk"

const PAGE = 100
const LOAD_MORE = "__timeline_load_more__"

function trim(message: Message): Message {
  if (message.role !== "user") return message
  if (!message.summary?.diffs) return message
  return {
    ...message,
    summary: {
      title: message.summary.title,
      body: message.summary.body,
      diffs: message.summary.diffs.map((diff) => ({
        ...diff,
        before: "",
        after: "",
      })),
    },
  }
}

export function DialogTimeline(props: {
  sessionID: string
  onMove: (messageID: string) => void
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const { theme } = useTheme()
  const [remote, setRemote] = createSignal<DialogSelectOption<string>[]>()
  const [loaded, setLoaded] = createSignal(0)
  const [loading, setLoading] = createSignal(false)
  const [finished, setFinished] = createSignal(false)
  const [query, setQuery] = createSignal("")

  function build(message: { id: string; created: number; parts: TextPart[] }[]) {
    const result = [] as DialogSelectOption<string>[]
    for (const item of message) {
      const part = item.parts.find((x) => !x.synthetic && !x.ignored)
      if (!part) continue
      result.push({
        title: part.text.replace(/\n/g, " "),
        value: item.id,
        footer: Locale.time(item.created),
        onSelect: (dialog) => {
          dialog.replace(() => (
            <DialogMessage messageID={item.id} sessionID={props.sessionID} setPrompt={props.setPrompt} />
          ))
        },
      })
    }
    result.reverse()
    return result
  }

  function cached() {
    return build(
      (sync.data.message[props.sessionID] ?? [])
        .filter((x) => x.role === "user")
        .map((x) => ({
          id: x.id,
          created: x.time.created,
          parts: (sync.data.part[x.id] ?? []).filter((part): part is TextPart => part.type === "text"),
        })),
    )
  }

  async function load(offset: number) {
    if (loading()) return
    setLoading(true)
    try {
      const result = await sdk.client.session.messages({
        sessionID: props.sessionID,
        offset,
        limit: PAGE,
      })
      const data = result.data ?? []
      if (data.length === 0) {
        setFinished(true)
        return
      }
      sync.set(
        produce((draft) => {
          const existing = draft.message[props.sessionID] ?? []
          const map = new Map(existing.map((x) => [x.id, x]))
          for (const message of data) {
            map.set(message.info.id, trim(message.info))
          }
          draft.message[props.sessionID] = Array.from(map.values()).sort(
            (a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id),
          )
          for (const message of data) {
            draft.part[message.info.id] = message.parts
          }
        }),
      )
      setLoaded(offset + data.length)
      setFinished(data.length < PAGE)
      setRemote(cached())
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    dialog.setSize("large")
    const existing = sync.data.message[props.sessionID]?.length ?? 0
    if (existing > 0) {
      setLoaded(existing)
      setRemote(cached())
      return
    }
    void load(0)
  })

  const options = createMemo((): DialogSelectOption<string>[] => {
    const base = remote() ?? cached()
    const q = query().trim().toLowerCase()
    const result = q ? base.filter((x) => x.title.toLowerCase().includes(q)) : base
    if (!finished()) {
      return [
        ...result,
        {
          title: loading() ? "Fetching older messages..." : "Load older messages...",
          value: LOAD_MORE,
          footer: loading() ? "please wait" : `${loaded()} loaded`,
          fg: theme.warning,
          onSelect: () => {
            if (loading()) return
            void load(loaded())
          },
        },
      ]
    }
    return result
  })

  return (
    <DialogSelect
      skipFilter
      onFilter={(value) => setQuery(value)}
      onMove={(option) => {
        if (option.value === LOAD_MORE) return
        props.onMove(option.value)
      }}
      title="Timeline"
      options={options()}
    />
  )
}
