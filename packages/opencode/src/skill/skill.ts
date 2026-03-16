import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { Effect, Layer, ServiceMap } from "effect"
import { NamedError } from "@opencode-ai/util/error"
import type { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { InstanceContext } from "@/effect/instance-context"
import { runPromiseInstance } from "@/effect/runtime"
import { Flag } from "@/flag/flag"
import { Global } from "@/global"
import { PermissionNext } from "@/permission"
import { Filesystem } from "@/util/filesystem"
import { Config } from "../config/config"
import { ConfigMarkdown } from "../config/markdown"
import { Glob } from "../util/glob"
import { Log } from "../util/log"
import { Discovery } from "./discovery"

export namespace Skill {
  const log = Log.create({ service: "skill" })
  const EXTERNAL_DIRS = [".claude", ".agents"]
  const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
  const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
  const SKILL_PATTERN = "**/SKILL.md"

  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    location: z.string(),
    content: z.string(),
  })
  export type Info = z.infer<typeof Info>

  export const InvalidError = NamedError.create(
    "SkillInvalidError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
    }),
  )

  export const NameMismatchError = NamedError.create(
    "SkillNameMismatchError",
    z.object({
      path: z.string(),
      expected: z.string(),
      actual: z.string(),
    }),
  )

  type State = {
    skills: Record<string, Info>
    dirs: Set<string>
    task?: Promise<void>
  }

  type Cache = State & {
    ensure: () => Promise<void>
  }

  export interface Interface {
    readonly get: (name: string) => Effect.Effect<Info | undefined>
    readonly all: () => Effect.Effect<Info[]>
    readonly dirs: () => Effect.Effect<string[]>
    readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
  }

  const add = async (state: State, match: string) => {
    const md = await ConfigMarkdown.parse(match).catch(async (err) => {
      const message = ConfigMarkdown.FrontmatterError.isInstance(err)
        ? err.data.message
        : `Failed to parse skill ${match}`
      const { Session } = await import("@/session")
      Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
      log.error("failed to load skill", { skill: match, err })
      return undefined
    })

    if (!md) return

    const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
    if (!parsed.success) return

    if (state.skills[parsed.data.name]) {
      log.warn("duplicate skill name", {
        name: parsed.data.name,
        existing: state.skills[parsed.data.name].location,
        duplicate: match,
      })
    }

    state.dirs.add(path.dirname(match))
    state.skills[parsed.data.name] = {
      name: parsed.data.name,
      description: parsed.data.description,
      location: Filesystem.normalize(match),
      content: md.content,
    }
  }

  const scan = async (state: State, root: string, pattern: string, opts?: { dot?: boolean; scope?: string }) => {
    return Glob.scan(pattern, {
      cwd: root,
      absolute: true,
      include: "file",
      symlink: true,
      dot: opts?.dot,
    })
      .then((matches) => Promise.all(matches.map((match) => add(state, match))))
      .catch((error) => {
        if (!opts?.scope) throw error
        log.error(`failed to scan ${opts.scope} skills`, { dir: root, error })
      })
  }

  // TODO: Migrate to Effect
  const create = (instance: InstanceContext.Shape, discovery: Discovery.Interface): Cache => {
    const state: State = {
      skills: {},
      dirs: new Set<string>(),
    }

    const load = async () => {
      if (!Flag.OPENCODE_DISABLE_EXTERNAL_SKILLS) {
        for (const dir of EXTERNAL_DIRS) {
          const root = path.join(Global.Path.home, dir)
          if (!(await Filesystem.isDir(root))) continue
          await scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "global" })
        }

        for await (const root of Filesystem.up({
          targets: EXTERNAL_DIRS,
          start: instance.directory,
          stop: instance.project.worktree,
        })) {
          await scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "project" })
        }
      }

      for (const dir of await Config.directories()) {
        await scan(state, dir, OPENCODE_SKILL_PATTERN)
      }

      const cfg = await Config.get()
      for (const item of cfg.skills?.paths ?? []) {
        const expanded = item.startsWith("~/") ? path.join(os.homedir(), item.slice(2)) : item
        const dir = path.isAbsolute(expanded) ? expanded : path.join(instance.directory, expanded)
        if (!(await Filesystem.isDir(dir))) {
          log.warn("skill path not found", { path: dir })
          continue
        }

        await scan(state, dir, SKILL_PATTERN)
      }

      for (const url of cfg.skills?.urls ?? []) {
        for (const dir of await Effect.runPromise(discovery.pull(url))) {
          state.dirs.add(dir)
          await scan(state, dir, SKILL_PATTERN)
        }
      }

      log.info("init", { count: Object.keys(state.skills).length })
    }

    const ensure = () => {
      if (state.task) return state.task
      state.task = load().catch((err) => {
        state.task = undefined
        throw err
      })
      return state.task
    }

    return { ...state, ensure }
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Skill") {}

  export const layer: Layer.Layer<Service, never, InstanceContext | Discovery.Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const instance = yield* InstanceContext
      const discovery = yield* Discovery.Service
      const state = create(instance, discovery)

      const get = Effect.fn("Skill.get")(function* (name: string) {
        yield* Effect.promise(() => state.ensure())
        return state.skills[name]
      })

      const all = Effect.fn("Skill.all")(function* () {
        yield* Effect.promise(() => state.ensure())
        return Object.values(state.skills)
      })

      const dirs = Effect.fn("Skill.dirs")(function* () {
        yield* Effect.promise(() => state.ensure())
        return Array.from(state.dirs)
      })

      const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
        yield* Effect.promise(() => state.ensure())
        const list = Object.values(state.skills).toSorted((a, b) => a.name.localeCompare(b.name))
        if (!agent) return list
        return list.filter((skill) => PermissionNext.evaluate("skill", skill.name, agent.permission).action !== "deny")
      })

      return Service.of({ get, all, dirs, available })
    }),
  )

  export const defaultLayer: Layer.Layer<Service, never, InstanceContext> = layer.pipe(
    Layer.provide(Discovery.defaultLayer),
  )

  export async function get(name: string) {
    return runPromiseInstance(Service.use((skill) => skill.get(name)))
  }

  export async function all() {
    return runPromiseInstance(Service.use((skill) => skill.all()))
  }

  export async function dirs() {
    return runPromiseInstance(Service.use((skill) => skill.dirs()))
  }

  export async function available(agent?: Agent.Info) {
    return runPromiseInstance(Service.use((skill) => skill.available(agent)))
  }

  export function fmt(list: Info[], opts: { verbose: boolean }) {
    if (list.length === 0) return "No skills are currently available."

    if (opts.verbose) {
      return [
        "<available_skills>",
        ...list.flatMap((skill) => [
          "  <skill>",
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          `    <location>${pathToFileURL(skill.location).href}</location>`,
          "  </skill>",
        ]),
        "</available_skills>",
      ].join("\n")
    }

    return ["## Available Skills", ...list.map((skill) => `- **${skill.name}**: ${skill.description}`)].join("\n")
  }
}

export namespace SkillService {
  export interface Service {
    readonly get: (name: string) => Effect.Effect<Skill.Info | undefined>
    readonly all: () => Effect.Effect<Skill.Info[]>
    readonly dirs: () => Effect.Effect<string[]>
    readonly available: (agent?: Agent.Info) => Effect.Effect<Skill.Info[]>
  }
}

export class SkillService extends ServiceMap.Service<SkillService, SkillService.Service>()("@opencode/Skill") {
  static readonly layer = Layer.effect(
    SkillService,
    Effect.gen(function* () {
      const instance = yield* InstanceContext
      const discovery = yield* DiscoveryService

      const skills: Record<string, Skill.Info> = {}
      const skillDirs = new Set<string>()
      let task: Promise<void> | undefined

      const addSkill = async (match: string) => {
        const md = await ConfigMarkdown.parse(match).catch(async (err) => {
          const message = ConfigMarkdown.FrontmatterError.isInstance(err)
            ? err.data.message
            : `Failed to parse skill ${match}`
          const { Session } = await import("@/session")
          Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
          log.error("failed to load skill", { skill: match, err })
          return undefined
        })

        if (!md) return

        const parsed = Skill.Info.pick({ name: true, description: true }).safeParse(md.data)
        if (!parsed.success) return

        // Warn on duplicate skill names
        if (skills[parsed.data.name]) {
          log.warn("duplicate skill name", {
            name: parsed.data.name,
            existing: skills[parsed.data.name].location,
            duplicate: match,
          })
        }

        skillDirs.add(path.dirname(match))

        skills[parsed.data.name] = {
          name: parsed.data.name,
          description: parsed.data.description,
          location: Filesystem.normalize(match),
          content: md.content,
        }
      }

      const scanExternal = async (root: string, scope: "global" | "project") => {
        return Glob.scan(EXTERNAL_SKILL_PATTERN, {
          cwd: root,
          absolute: true,
          include: "file",
          dot: true,
          symlink: true,
        })
          .then((matches) => Promise.all(matches.map(addSkill)))
          .catch((error) => {
            log.error(`failed to scan ${scope} skills`, { dir: root, error })
          })
      }

      function ensureScanned() {
        if (task) return task
        task = (async () => {
          // Scan external skill directories (.claude/skills/, .agents/skills/, etc.)
          // Load global (home) first, then project-level (so project-level overwrites)
          if (!Flag.OPENCODE_DISABLE_EXTERNAL_SKILLS) {
            for (const dir of EXTERNAL_DIRS) {
              const root = path.join(Global.Path.home, dir)
              if (!(await Filesystem.isDir(root))) continue
              await scanExternal(root, "global")
            }

            for await (const root of Filesystem.up({
              targets: EXTERNAL_DIRS,
              start: instance.directory,
              stop: instance.project.worktree,
            })) {
              await scanExternal(root, "project")
            }
          }

          // Scan .opencode/skill/ directories
          for (const dir of await Config.directories()) {
            const matches = await Glob.scan(OPENCODE_SKILL_PATTERN, {
              cwd: dir,
              absolute: true,
              include: "file",
              symlink: true,
            })
            for (const match of matches) {
              await addSkill(match)
            }
          }

          // Scan additional skill paths from config
          const config = await Config.get()
          for (const skillPath of config.skills?.paths ?? []) {
            const expanded = skillPath.startsWith("~/") ? path.join(os.homedir(), skillPath.slice(2)) : skillPath
            const resolved = path.isAbsolute(expanded) ? expanded : path.join(instance.directory, expanded)
            if (!(await Filesystem.isDir(resolved))) {
              log.warn("skill path not found", { path: resolved })
              continue
            }
            const matches = await Glob.scan(SKILL_PATTERN, {
              cwd: resolved,
              absolute: true,
              include: "file",
              symlink: true,
            })
            for (const match of matches) {
              await addSkill(match)
            }
          }

          // Download and load skills from URLs
          for (const url of config.skills?.urls ?? []) {
            const list = await Effect.runPromise(discovery.pull(url))
            for (const dir of list) {
              skillDirs.add(dir)
              const matches = await Glob.scan(SKILL_PATTERN, {
                cwd: dir,
                absolute: true,
                include: "file",
                symlink: true,
              })
              for (const match of matches) {
                await addSkill(match)
              }
            }
          }

          log.info("init", { count: Object.keys(skills).length })
        })().catch((err) => {
          task = undefined
          throw err
        })
        return task
      }

      return SkillService.of({
        get: Effect.fn("SkillService.get")(function* (name: string) {
          yield* Effect.promise(() => ensureScanned())
          return skills[name]
        }),
        all: Effect.fn("SkillService.all")(function* () {
          yield* Effect.promise(() => ensureScanned())
          return Object.values(skills)
        }),
        dirs: Effect.fn("SkillService.dirs")(function* () {
          yield* Effect.promise(() => ensureScanned())
          return Array.from(skillDirs)
        }),
        available: Effect.fn("SkillService.available")(function* (agent?: Agent.Info) {
          yield* Effect.promise(() => ensureScanned())
          const list = Object.values(skills)
          if (!agent) return list
          return list.filter(
            (skill) => PermissionNext.evaluate("skill", skill.name, agent.permission).action !== "deny",
          )
        }),
      })
    }),
  ).pipe(Layer.provide(DiscoveryService.defaultLayer))
}
