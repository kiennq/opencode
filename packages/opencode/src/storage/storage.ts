import { Log } from "../util/log"
import path from "node:path"
import fs from "node:fs/promises"
import { Global } from "../global/index"
import { Filesystem } from "../util/filesystem"
import { lazy } from "../util/lazy"
import { Lock } from "../util/lock"
import { File, Glob, Process } from "@opencode-ai/runtime"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"

export namespace Storage {
  const log = Log.create({ service: "storage" })

  type Migration = (dir: string) => Promise<void>

  export const NotFoundError = NamedError.create(
    "NotFoundError",
    z.object({
      message: z.string(),
    }),
  )

  const MIGRATIONS: Migration[] = [
    async (dir) => {
      const project = path.resolve(dir, "../project")
      if (!(await Filesystem.isDir(project))) return
      for await (const projectDir of Glob.scan("*", {
        cwd: project,
        onlyFiles: false,
      })) {
        log.info(`migrating project ${projectDir}`)
        let projectID = projectDir
        const fullProjectDir = path.join(project, projectDir)
        let worktree = "/"

        if (projectID !== "global") {
          for await (const msgFile of Glob.scan("storage/session/message/*/*.json", {
            cwd: path.join(project, projectDir),
            absolute: true,
          })) {
            const content = await File.read(msgFile)
            const json = JSON.parse(content)
            worktree = json.path?.root
            if (worktree) break
          }
          if (!worktree) continue
          if (!(await Filesystem.isDir(worktree))) continue

          // Run git command to get root commit id
          const result = await Process.exec("git rev-list --max-parents=0 --all", { cwd: worktree })
          const [id] = result.stdout
            .split("\n")
            .filter(Boolean)
            .map((x) => x.trim())
            .toSorted()
          if (!id) continue
          projectID = id

          await File.write(
            path.join(dir, "project", projectID + ".json"),
            JSON.stringify({
              id,
              vcs: "git",
              worktree,
              time: {
                created: Date.now(),
                initialized: Date.now(),
              },
            }),
          )

          log.info(`migrating sessions for project ${projectID}`)
          for await (const sessionFile of Glob.scan("storage/session/info/*.json", {
            cwd: fullProjectDir,
            absolute: true,
          })) {
            const dest = path.join(dir, "session", projectID, path.basename(sessionFile))
            log.info("copying", {
              sessionFile,
              dest,
            })
            const sessionContent = await File.read(sessionFile)
            const session = JSON.parse(sessionContent)
            await File.write(dest, JSON.stringify(session))
            log.info(`migrating messages for session ${session.id}`)
            for await (const msgFile of Glob.scan(`storage/session/message/${session.id}/*.json`, {
              cwd: fullProjectDir,
              absolute: true,
            })) {
              const dest = path.join(dir, "message", session.id, path.basename(msgFile))
              log.info("copying", {
                msgFile,
                dest,
              })
              const messageContent = await File.read(msgFile)
              const message = JSON.parse(messageContent)
              await File.write(dest, JSON.stringify(message))

              log.info(`migrating parts for message ${message.id}`)
              for await (const partFile of Glob.scan(`storage/session/part/${session.id}/${message.id}/*.json`, {
                cwd: fullProjectDir,
                absolute: true,
              })) {
                const dest = path.join(dir, "part", message.id, path.basename(partFile))
                const partContent = await File.read(partFile)
                const part = JSON.parse(partContent)
                log.info("copying", {
                  partFile,
                  dest,
                })
                await File.write(dest, JSON.stringify(part))
              }
            }
          }
        }
      }
    },
    async (dir) => {
      for await (const item of Glob.scan("session/*/*.json", {
        cwd: dir,
        absolute: true,
      })) {
        const sessionContent = await File.read(item)
        const session = JSON.parse(sessionContent)
        if (!session.projectID) continue
        if (!session.summary?.diffs) continue
        const { diffs } = session.summary
        await File.write(path.join(dir, "session_diff", session.id + ".json"), JSON.stringify(diffs))
        await File.write(
          path.join(dir, "session", session.projectID, session.id + ".json"),
          JSON.stringify({
            ...session,
            summary: {
              additions: diffs.reduce((sum: any, x: any) => sum + x.additions, 0),
              deletions: diffs.reduce((sum: any, x: any) => sum + x.deletions, 0),
            },
          }),
        )
      }
    },
  ]

  const state = lazy(async () => {
    const dir = path.join(Global.Path.data, "storage")
    const migrationPath = path.join(dir, "migration")
    let migration = 0
    try {
      const content = await File.read(migrationPath)
      migration = parseInt(content)
    } catch {
      migration = 0
    }
    for (let index = migration; index < MIGRATIONS.length; index++) {
      log.info("running migration", { index })
      const migrationFn = MIGRATIONS[index]
      await migrationFn(dir).catch(() => log.error("failed to run migration", { index }))
      await File.write(path.join(dir, "migration"), (index + 1).toString())
    }
    return {
      dir,
    }
  })

  export async function remove(key: string[]) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      await fs.unlink(target).catch(() => {})
    })
  }

  export async function read<T>(key: string[]) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.read(target)
      const content = await File.read(target)
      return JSON.parse(content) as T
    })
  }

  export async function update<T>(key: string[], fn: (draft: T) => void) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      const content = await File.read(target)
      const parsed = JSON.parse(content)
      fn(parsed)
      await File.write(target, JSON.stringify(parsed))
      return parsed as T
    })
  }

  export async function write<T>(key: string[], content: T) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      await File.write(target, JSON.stringify(content))
    })
  }

  async function withErrorHandling<T>(body: () => Promise<T>) {
    return body().catch((e) => {
      if (!(e instanceof Error)) throw e
      const errnoException = e as NodeJS.ErrnoException
      if (errnoException.code === "ENOENT") {
        throw new NotFoundError({ message: `Resource not found: ${errnoException.path}` })
      }
      throw e
    })
  }

  export async function list(prefix: string[]) {
    const dir = await state().then((x) => x.dir)
    try {
      const results: string[] = []
      for await (const x of Glob.scan("**/*", {
        cwd: path.join(dir, ...prefix),
        onlyFiles: true,
      })) {
        results.push(x)
      }
      const result = results.map((x) => {
        // x is already relative to cwd, just remove .json extension
        const withoutExt = x.slice(0, -5)
        // Split by both separators for cross-platform compatibility
        // This handles synced data from Windows (\) on Unix-like systems (/) and vice versa
        const parts = withoutExt.split(/[\/\\]/)
        return [...prefix, ...parts]
      })
      result.sort()
      return result
    } catch {
      return []
    }
  }
}
