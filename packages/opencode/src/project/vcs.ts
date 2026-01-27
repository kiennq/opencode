import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { $ } from "bun"
import path from "path"
import z from "zod"
import { Log } from "@/util/log"
import { Instance } from "./instance"
import { FileWatcher } from "@/file/watcher"

const log = Log.create({ service: "vcs" })

export namespace Vcs {
  export const Event = {
    BranchUpdated: BusEvent.define(
      "vcs.branch.updated",
      z.object({
        branch: z.string().optional(),
      }),
    ),
  }

  export const Info = z
    .object({
      branch: z.string(),
    })
    .meta({
      ref: "VcsInfo",
    })
  export type Info = z.infer<typeof Info>

  async function currentBranch() {
    return $`git rev-parse --abbrev-ref HEAD`
      .quiet()
      .nothrow()
      .cwd(Instance.worktree)
      .text()
      .then((x) => x.trim())
      .catch(() => undefined)
  }

  const state = Instance.state(
    async () => {
      if (Instance.project.vcs !== "git") {
        return { branch: async () => undefined, unsubscribe: undefined }
      }
      let current = await currentBranch()
      log.info("initialized", { branch: current })

      // Debounce branch checks - only check at most once per 500ms
      let debounceTimer: ReturnType<typeof setTimeout> | undefined
      const debouncedCheck = () => {
        if (debounceTimer) return
        debounceTimer = setTimeout(async () => {
          debounceTimer = undefined
          const next = await currentBranch()
          if (next !== current) {
            log.info("branch changed", { from: current, to: next })
            current = next
            Bus.publish(Event.BranchUpdated, { branch: next })
          }
        }, 500)
      }

      const unsubscribe = Bus.subscribe(FileWatcher.Event.Updated, async (evt) => {
        // Only check on git-related file changes
        if (!evt.properties.file.includes(".git")) return
        if (evt.properties.file.endsWith("HEAD")) return
        debouncedCheck()
      })

      return {
        branch: async () => current,
        unsubscribe: () => {
          unsubscribe()
          if (debounceTimer) clearTimeout(debounceTimer)
        },
      }
    },
    async (state) => {
      state.unsubscribe?.()
    },
  )

  export async function init() {
    return state()
  }

  export async function branch() {
    return await state().then((s) => s.branch())
  }
}
