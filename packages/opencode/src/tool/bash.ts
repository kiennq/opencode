import z from "zod"
import { type ChildProcessWithoutNullStreams, spawn } from "child_process"
import { Tool } from "./tool"
import path from "path"
import DESCRIPTION from "./bash.txt"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { lazy } from "@/util/lazy"
import { Language } from "web-tree-sitter"

import { Filesystem } from "@/util/filesystem"
import { fileURLToPath } from "url"
import { Flag } from "@/flag/flag.ts"
import { Shell } from "@/shell/shell"

import { BashArity } from "@/permission/arity"
import { Truncate } from "./truncation"
import { Plugin } from "@/plugin"
import fs from "fs"

const MAX_METADATA_LENGTH = 30_000
const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000

type SessionShell = {
  shell: string
  cwd: string
  env: string
  process: ChildProcessWithoutNullStreams
  queue: Promise<void>
}

function envkey(env: Record<string, string>) {
  return Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\0")
}

const shells = Instance.state(
  () => new Map<string, SessionShell>(),
  async (state) => {
    for (const session of state.values()) {
      try {
        await Shell.killTree(session.process)
      } catch {}
    }
    state.clear()
  },
)

function quotePosix(input: string) {
  return `'${input.replace(/'/g, `'"'"'`)}'`
}

function quotePowerShell(input: string) {
  return `'${input.replace(/'/g, "''")}'`
}

function quoteCmd(input: string) {
  return `"${input.replace(/"/g, '""')}"`
}

function marker() {
  return `__OPENCODE_EXIT_${Date.now()}_${Math.random().toString(36).slice(2)}__:`
}

function escapeRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function vars(shell: string, env: Record<string, string>) {
  if (Object.keys(env).length === 0) return []
  if (process.platform === "win32" && Shell.isPowerShellShell(shell)) {
    return Object.entries(env).map(([key, value]) => `$env:${key} = ${quotePowerShell(value)}`)
  }
  if (process.platform === "win32" && Shell.isCmdShell(shell)) {
    return Object.entries(env).map(([key, value]) => `set ${quoteCmd(`${key}=${value}`)}`)
  }
  return Object.entries(env).flatMap(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return []
    return [`export ${key}=${quotePosix(value)}`]
  })
}

function build(shell: string, command: string, mark: string, env: Record<string, string>) {
  const lines = vars(shell, env)
  if (process.platform === "win32" && Shell.isPowerShellShell(shell)) {
    return [
      ...lines,
      `$ErrorActionPreference = 'Continue'`,
      `& { ${command} } < $null`,
      `Write-Output \"${mark}$LASTEXITCODE\"`,
      "",
    ].join("\n")
  }
  if (process.platform === "win32" && Shell.isCmdShell(shell)) {
    return [...lines, `(${command}) <NUL`, `echo ${mark}%ERRORLEVEL%`, ""].join("\r\n")
  }
  return [...lines, `{ ${command}; } </dev/null`, `printf '${mark}%s\n' \"$?\"`, ""].join("\n")
}

async function create(sessionID: string, shell: string, cwd: string, env: Record<string, string>) {
  const current = shells().get(sessionID)
  const key = envkey(env)
  if (
    current &&
    current.shell === shell &&
    current.cwd === cwd &&
    current.env === key &&
    !current.process.killed &&
    current.process.exitCode === null
  )
    return current
  if (current) {
    try {
      await Shell.killTree(current.process)
    } catch {}
    shells().delete(sessionID)
  }

  const args =
    process.platform === "win32" && Shell.isPowerShellShell(shell)
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"]
      : process.platform === "win32" && Shell.isCmdShell(shell)
        ? ["/d", "/q", "/k"]
        : Shell.isUnixLike(shell) && path.basename(shell).toLowerCase().startsWith("bash")
          ? ["--noprofile", "--norc"]
          : []

  const processRef = spawn(shell, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
    windowsHide: process.platform === "win32",
  })

  const created = {
    shell,
    cwd,
    env: key,
    process: processRef,
    queue: Promise.resolve(),
  }
  processRef.once("exit", () => {
    const currentShell = shells().get(sessionID)
    if (currentShell?.process === processRef) shells().delete(sessionID)
  })
  shells().set(sessionID, created)
  return created
}

async function run(
  sessionID: string,
  shell: string,
  cwd: string,
  env: Record<string, string>,
  vars: Record<string, string>,
  command: string,
  timeout: number,
  abort: AbortSignal,
) {
  const session = await create(sessionID, shell, cwd, env)
  const next = session.queue.then(async () => {
    const mark = marker()
    const regex = new RegExp(`${escapeRegExp(mark)}(-?\\d+)`)
    const script = build(shell, command, mark, vars)
    let output = ""
    let timedOut = false
    let aborted = false

    const result = await new Promise<{ output: string; exit: number | null; timedOut: boolean; aborted: boolean }>(
      (resolve, reject) => {
        let done = false
        const cleanup = () => {
          clearTimeout(timer)
          abort.removeEventListener("abort", onAbort)
          session.process.stdout.removeListener("data", onData)
          session.process.stderr.removeListener("data", onData)
          session.process.removeListener("error", onError)
          session.process.removeListener("exit", onExit)
        }
        const finish = (exit: number | null) => {
          if (done) return
          done = true
          cleanup()
          resolve({
            output,
            exit,
            timedOut,
            aborted,
          })
        }
        const fail = (error: Error) => {
          if (done) return
          done = true
          cleanup()
          reject(error)
        }
        const onData = (chunk: Buffer) => {
          output += chunk.toString()
          const match = output.match(regex)
          if (!match) return
          finish(Number(match[1]))
        }
        const onError = (error: Error) => fail(error)
        const onExit = () => {
          if (timedOut || aborted) {
            finish(session.process.exitCode)
            return
          }
          fail(new Error("Persistent shell exited unexpectedly"))
        }
        const onAbort = () => {
          aborted = true
          void Shell.killTree(session.process)
          shells().delete(sessionID)
        }
        const timer = setTimeout(() => {
          timedOut = true
          void Shell.killTree(session.process)
          shells().delete(sessionID)
        }, timeout + 100)

        if (abort.aborted) onAbort()
        abort.addEventListener("abort", onAbort, { once: true })
        session.process.stdout.on("data", onData)
        session.process.stderr.on("data", onData)
        session.process.once("error", onError)
        session.process.once("exit", onExit)
        session.process.stdin.write(script, (error) => {
          if (error) fail(error)
        })
      },
    )

    const cleaned = result.output.replace(new RegExp(`${escapeRegExp(mark)}-?\\d+\\r?\\n?`, "g"), "")
    return {
      output: cleaned,
      exit: result.exit,
      timedOut: result.timedOut,
      aborted: result.aborted,
    }
  })

  session.queue = next.then(
    () => {},
    () => {},
  )
  return next
}

export const log = Log.create({ service: "bash-tool" })

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const bashLanguage = await Language.load(bashPath)
  const p = new Parser()
  p.setLanguage(bashLanguage)
  return p
})

// TODO: we may wanna rename this tool so it works better on other shells
export const BashTool = Tool.define("bash", async () => {
  return {
    description: DESCRIPTION.replaceAll("${directory}", Instance.directory)
      .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
      .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES))
      .replaceAll("${os}", process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux")
      .replaceAll("${shell}", process.platform === "win32" ? Shell.display(Shell.commandShell("")) : "bash")
      .replaceAll(
        "${chaining}",
        process.platform === "win32" && Shell.isPowerShellShell(Shell.commandShell(""))
          ? "use a single Bash call and chain them with `; if ($?) { ... }` (e.g., `git add .; if ($?) { git commit -m 'message' }; if ($?) { git push }`). NOTE: `&&` does NOT work in Windows PowerShell 5.1. For instance, if one operation must complete before another starts (like mkdir before cp, Write before Bash for git operations, or git add before git commit), run these operations sequentially instead."
          : "use a single Bash call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before Bash for git operations, or git add before git commit), run these operations sequentially instead.",
      ),
    parameters: z.object({
      command: z.string().describe("The command to execute"),
      timeout: z.number().describe("Optional timeout in milliseconds").optional(),
      workdir: z
        .string()
        .describe(
          `The working directory to run the command in. Defaults to ${Instance.directory}. Use this instead of 'cd' commands.`,
        )
        .optional(),
      description: z
        .string()
        .describe(
          "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
        ),
    }),
    async execute(params, ctx) {
      const cwd = params.workdir || Instance.directory
      if (params.timeout !== undefined && params.timeout < 0) {
        throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
      }
      const timeout = params.timeout ?? DEFAULT_TIMEOUT
      const tree = await parser().then((p) => p.parse(params.command))
      if (!tree) {
        throw new Error("Failed to parse command")
      }
      const directories = new Set<string>()
      if (!Instance.containsPath(cwd)) directories.add(cwd)
      const patterns = new Set<string>()
      const always = new Set<string>()

      for (const node of tree.rootNode.descendantsOfType("command")) {
        if (!node) continue

        // Get full command text including redirects if present
        let commandText = node.parent?.type === "redirected_statement" ? node.parent.text : node.text

        const command = []
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i)
          if (!child) continue
          if (
            child.type !== "command_name" &&
            child.type !== "word" &&
            child.type !== "string" &&
            child.type !== "raw_string" &&
            child.type !== "concatenation"
          ) {
            continue
          }
          command.push(child.text)
        }

        // not an exhaustive list, but covers most common cases
        if (["cd", "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown", "cat"].includes(command[0])) {
          for (const arg of command.slice(1)) {
            if (arg.startsWith("-") || (command[0] === "chmod" && arg.startsWith("+"))) continue
            const target = arg.replace(/^['"]|['"]$/g, "")
            const resolved = (() => {
              const absolute = path.resolve(cwd, target)
              try {
                return fs.realpathSync(absolute)
              } catch {
                return absolute
              }
            })()
            log.info("resolved path", { arg, resolved })
            if (resolved) {
              const normalized =
                process.platform === "win32" ? Filesystem.windowsPath(resolved).replace(/\//g, "\\") : resolved
              if (!Instance.containsPath(normalized)) {
                const dir = (await Filesystem.isDir(normalized)) ? normalized : path.dirname(normalized)
                directories.add(dir)
              }
            }
          }
        }

        // cd covered by above check
        if (command.length && command[0] !== "cd") {
          patterns.add(commandText)
          always.add(BashArity.prefix(command).join(" ") + " *")
        }
      }

      if (directories.size > 0) {
        const globs = Array.from(directories).map((dir) => {
          // Preserve POSIX-looking paths with /s, even on Windows
          if (dir.startsWith("/")) return `${dir.replace(/[\\/]+$/, "")}/*`
          return path.join(dir, "*")
        })
        await ctx.ask({
          permission: "external_directory",
          patterns: globs,
          always: globs,
          metadata: {},
        })
      }

      if (patterns.size > 0) {
        await ctx.ask({
          permission: "bash",
          patterns: Array.from(patterns),
          always: Array.from(always),
          metadata: {},
        })
      }

      const shellEnv = await Plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      const shell = Shell.commandShell(params.command)
      log.info("bash tool using shell", { shell })
      const env = {
        ...process.env,
        ...(Instance.env ?? {}),
        ...shellEnv.env,
      }
      const commandVars = Object.fromEntries(
        Object.entries({
          ...(Instance.env ?? {}),
          ...shellEnv.env,
        }).flatMap(([key, value]): [string, string][] => {
          if (typeof value !== "string") return []
          if (process.env[key] === value) return []
          return [[key, value]]
        }),
      )
      // Initialize metadata with empty output
      ctx.metadata({
        metadata: {
          output: "",
          description: params.description,
        },
      })

      let output = ""
      const result = await run(ctx.sessionID, shell, cwd, env, commandVars, params.command, timeout, ctx.abort)
      output += result.output

      const resultMetadata: string[] = []

      if (result.timedOut) {
        resultMetadata.push(`bash tool terminated command after exceeding timeout ${timeout} ms`)
      }

      if (result.aborted) {
        resultMetadata.push("User aborted the command")
      }

      if (resultMetadata.length > 0) {
        output += "\n\n<bash_metadata>\n" + resultMetadata.join("\n") + "\n</bash_metadata>"
      }

      const truncated = await Truncate.output(output)

      return {
        title: params.description,
        metadata: {
          output:
            truncated.content.length > MAX_METADATA_LENGTH
              ? truncated.content.slice(0, MAX_METADATA_LENGTH) + "\n\n..."
              : truncated.content,
          exit: result.exit,
          description: params.description,
          truncated: truncated.truncated,
          outputPath: truncated.truncated ? truncated.outputPath : undefined,
        },
        output: truncated.content,
      }
    },
  }
})
