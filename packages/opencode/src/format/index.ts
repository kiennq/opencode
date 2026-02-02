import { Bus } from "../bus/index"
import { File } from "../file/index"
import { Log } from "../util/log"
import path from "node:path"
import z from "zod"
import { Process } from "@opencode-ai/runtime"

import * as Formatter from "./formatter"
import { Config } from "../config/config"
import { mergeDeep } from "remeda"
import { Instance } from "../project/instance"
import { instanceState } from "@/project/instance-state"

export namespace Format {
  const log = Log.create({ service: "format" })

  export const Status = z
    .object({
      name: z.string(),
      extensions: z.string().array(),
      enabled: z.boolean(),
    })
    .meta({
      ref: "FormatterStatus",
    })
  export type Status = z.infer<typeof Status>

  export function init() {
    log.info("init")
    // Subscribe to File.Event.Edited with proper cleanup via state()
    state()
  }

  const state = instanceState(
    async () => {
      const cfg = await Config.get()
      const enabled: Record<string, boolean> = {}
      const formatters: Record<string, Formatter.Info> = {}

      if (cfg.formatter === false) {
        log.info("all formatters are disabled")
        return {
          enabled,
          formatters,
          unsub: undefined,
        }
      }

      for (const item of Formatter.all) {
        formatters[item.name] = item
      }
      for (const [name, item] of Object.entries(cfg.formatter ?? {})) {
        if (item.disabled) {
          delete formatters[name]
          continue
        }
        const result: Formatter.Info = mergeDeep(formatters[name] ?? {}, {
          command: [],
          extensions: [],
          ...item,
        })

        if (result.command.length === 0) continue

        result.enabled = async () => true
        result.name = name
        formatters[name] = result
      }

      const unsub = Bus.subscribe(File.Event.Edited, async (payload) => {
        const file = payload.properties.file
        log.info("formatting", { file })
        const ext = path.extname(file)

        for (const item of await getFormatterFromState({ enabled, formatters }, ext)) {
          log.info("running", { command: item.command })
          try {
            const proc = Process.spawn(
              item.command.map((x) => x.replace("$FILE", file)),
              {
                cwd: Instance.directory,
                env: { ...process.env, ...item.environment },
                stdout: "ignore",
                stderr: "ignore",
              },
            )
            const exit = await proc.exited
            if (exit !== 0)
              log.error("failed", {
                command: item.command,
                ...item.environment,
              })
          } catch (error) {
            log.error("failed to format file", {
              error,
              command: item.command,
              ...item.environment,
              file,
            })
          }
        }
      })

      return {
        enabled,
        formatters,
        unsub,
      }
    },
    async (s) => {
      if (s.unsub) s.unsub()
    },
  )

  async function isEnabledFromState(
    s: { enabled: Record<string, boolean>; formatters: Record<string, Formatter.Info> },
    item: Formatter.Info,
  ) {
    let status = s.enabled[item.name]
    if (status === undefined) {
      status = await item.enabled()
      s.enabled[item.name] = status
    }
    return status
  }

  async function getFormatterFromState(
    s: { enabled: Record<string, boolean>; formatters: Record<string, Formatter.Info> },
    ext: string,
  ) {
    const result = []
    for (const item of Object.values(s.formatters)) {
      log.info("checking", { name: item.name, ext })
      if (!item.extensions.includes(ext)) continue
      if (!(await isEnabledFromState(s, item))) continue
      log.info("enabled", { name: item.name, ext })
      result.push(item)
    }
    return result
  }

  async function isEnabled(item: Formatter.Info) {
    const s = await state()
    return isEnabledFromState(s, item)
  }

  async function getFormatter(ext: string) {
    const s = await state()
    return getFormatterFromState(s, ext)
  }

  export async function status() {
    const s = await state()
    const result: Status[] = []
    for (const formatter of Object.values(s.formatters)) {
      const enabled = await isEnabledFromState(s, formatter)
      result.push({
        name: formatter.name,
        extensions: formatter.extensions,
        enabled,
      })
    }
    return result
  }
}
