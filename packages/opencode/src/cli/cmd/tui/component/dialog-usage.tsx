import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useSync } from "@tui/context/sync"
import { useDialog } from "@tui/ui/dialog"
import { For, Show, createSignal } from "solid-js"
import { useTheme } from "../context/theme"
import type { UsageDisplayMode, UsageEntry, UsageError, UsageWindow } from "./usage-data"
import {
  formatCreditsLabel,
  formatPlanType,
  formatUsageResetLong,
  formatUsageWindowLabel,
  usageBarColor,
  usageBarString,
  usageDisplay,
} from "./usage-format"

type Theme = ReturnType<typeof useTheme>["theme"]
type UsageConfig = {
  tui?: {
    show_usage_value_mode?: UsageDisplayMode
  }
}

export function DialogUsage(props: { entries: UsageEntry[]; errors?: UsageError[]; initialMode?: UsageDisplayMode }) {
  const { theme } = useTheme()
  const sync = useSync()
  const dialog = useDialog()
  const [hover, setHover] = createSignal(false)
  const [mode, setMode] = createSignal<UsageDisplayMode>(
    props.initialMode ?? (sync.data.config as UsageConfig).tui?.show_usage_value_mode ?? "used",
  )

  useKeyboard((evt) => {
    if (evt.name !== "tab") return
    evt.preventDefault()
    setMode((value) => (value === "used" ? "remaining" : "used"))
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1} flexDirection="column">
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Usage
        </text>
        <box flexDirection="row" gap={1} alignItems="center">
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.text }}>tab</span> toggle view
          </text>
          <box
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={hover() ? theme.primary : undefined}
            onMouseOver={() => setHover(true)}
            onMouseOut={() => setHover(false)}
            onMouseUp={() => dialog.clear()}
          >
            <text fg={hover() ? theme.selectedListItemText : theme.textMuted}>esc</text>
          </box>
        </box>
      </box>
      <Show when={props.entries.length > 0} fallback={<text fg={theme.text}>No usage data available.</text>}>
        <For each={props.entries}>
          {(entry, index) => {
            const planType = formatPlanType(entry.snapshot.planType)
            const entryErrors = (props.errors ?? [])
              .filter((error) => error.provider === entry.provider)
              .map((error) => error.message)
            return (
              <box flexDirection="column" marginTop={index() === 0 ? 0 : 1} gap={1}>
                <box flexDirection="column">
                  <text fg={theme.text} attributes={TextAttributes.BOLD}>
                    {entry.displayName} Usage
                    <Show when={planType}>
                      <span style={{ fg: theme.textMuted }}>{` (${planType})`}</span>
                    </Show>
                  </text>
                  <text fg={theme.textMuted}>{"─".repeat(Math.max(24, entry.displayName.length + 20))}</text>
                </box>
                <Show when={entry.snapshot.primary}>
                  {(window) => (
                    <box flexDirection="column">{renderWindow(entry.provider, "primary", window(), mode(), theme)}</box>
                  )}
                </Show>
                <Show when={entry.snapshot.secondary}>
                  {(window) => (
                    <box flexDirection="column">
                      {renderWindow(entry.provider, "secondary", window(), mode(), theme)}
                    </box>
                  )}
                </Show>
                <Show when={entry.snapshot.tertiary}>
                  {(window) => (
                    <box flexDirection="column">
                      {renderWindow(entry.provider, "tertiary", window(), mode(), theme)}
                    </box>
                  )}
                </Show>
                <Show when={entry.snapshot.credits}>
                  {(credits) => (
                    <text fg={theme.text}>
                      {formatCreditsLabel(entry.provider, credits(), {
                        mode: mode(),
                        slot: "secondary",
                      })}
                    </text>
                  )}
                </Show>
                <Show when={entryErrors.length > 0}>
                  <text fg={theme.error} attributes={TextAttributes.DIM}>
                    {entryErrors.join(" • ")}
                  </text>
                </Show>
              </box>
            )
          }}
        </For>
      </Show>
    </box>
  )
}

function renderWindow(
  provider: string,
  windowType: "primary" | "secondary" | "tertiary",
  window: UsageWindow,
  mode: UsageDisplayMode,
  theme: Theme,
  showReset = true,
) {
  const usedPercent = usageDisplay(window.usedPercent, "used").percent
  const display = usageDisplay(window.usedPercent, mode)
  const label = formatUsageWindowLabel(provider, windowType, window.windowMinutes)

  return (
    <box flexDirection="column">
      <text fg={theme.text}>
        {label} Limit: [<span style={{ fg: usageBarColor(usedPercent, theme) }}>{usageBarString(display.percent)}</span>
        ] {display.percent.toFixed(0)}% {display.label}
      </text>
      <Show when={showReset && window.resetsAt !== null}>
        <text fg={theme.textMuted}>Resets {formatUsageResetLong(window.resetsAt!)}</text>
      </Show>
    </box>
  )
}
