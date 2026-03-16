import { Flag } from "@/flag/flag"
import { lazy } from "@/util/lazy"
import { Filesystem } from "@/util/filesystem"
import { which } from "@/util/which"
import path from "path"
import { spawn, type ChildProcess } from "child_process"
import { setTimeout as sleep } from "node:timers/promises"

const SIGKILL_TIMEOUT_MS = 200
const CMD_BUILTIN = new Set([
  "assoc",
  "break",
  "call",
  "cd",
  "chcp",
  "chdir",
  "cls",
  "color",
  "copy",
  "date",
  "del",
  "dir",
  "echo",
  "endlocal",
  "erase",
  "for",
  "ftype",
  "if",
  "md",
  "mkdir",
  "mklink",
  "move",
  "path",
  "pause",
  "popd",
  "prompt",
  "pushd",
  "rd",
  "rem",
  "ren",
  "rename",
  "rmdir",
  "set",
  "setlocal",
  "shift",
  "start",
  "time",
  "title",
  "type",
  "ver",
  "verify",
  "vol",
])
const POWERSHELL = new Set(["pwsh", "pwsh.exe", "powershell", "powershell.exe"])

function head(command: string) {
  const trimmed = command.trim()
  if (!trimmed) return ""
  return path.basename(trimmed.split(/\s+/, 1)[0]).toLowerCase()
}

export namespace Shell {
  const BLACKLIST = new Set(["fish", "nu"])
  const LOGIN = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"])
  const POSIX = new Set(["bash", "dash", "ksh", "sh", "zsh"])

  function nativeWindowsShell() {
    return pwsh() ?? powershell() ?? process.env.COMSPEC ?? "cmd.exe"
  }

  export function isWindowsCmdBuiltin(command: string) {
    return CMD_BUILTIN.has(head(command))
  }

  export function isPowerShell(command: string) {
    return POWERSHELL.has(head(command))
  }

  export function isPowerShellShell(shell: string) {
    const name = path
      .basename(shell)
      .toLowerCase()
      .replace(/\.exe$/, "")
    return name === "pwsh" || name === "powershell"
  }

  export function isCmdShell(shell: string) {
    const name = path
      .basename(shell)
      .toLowerCase()
      .replace(/\.exe$/, "")
    return name === "cmd"
  }

  export function display(shell: string) {
    return path
      .basename(shell)
      .replace(/\.exe$/i, "")
      .toLowerCase()
  }

  export function hasWindowsExpansion(command: string) {
    return /%[a-zA-Z_][a-zA-Z0-9_]*%/.test(command)
  }

  export function commandShell(command: string) {
    const base = acceptable()
    if (process.platform !== "win32") return base
    const native = nativeWindowsShell()
    if (isPowerShell(command)) return native
    if (hasWindowsExpansion(command)) return process.env.COMSPEC || "cmd.exe"
    return native
  }
  export async function killTree(proc: ChildProcess, opts?: { exited?: () => boolean }): Promise<void> {
    const pid = proc.pid
    if (!pid || opts?.exited?.()) return

    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
          stdio: "ignore",
          windowsHide: true,
        })
        killer.once("exit", () => resolve())
        killer.once("error", () => resolve())
      })
      return
    }

    try {
      process.kill(-pid, "SIGTERM")
      await sleep(SIGKILL_TIMEOUT_MS)
      if (!opts?.exited?.()) {
        process.kill(-pid, "SIGKILL")
      }
    } catch (_e) {
      proc.kill("SIGTERM")
      await sleep(SIGKILL_TIMEOUT_MS)
      if (!opts?.exited?.()) {
        proc.kill("SIGKILL")
      }
    }
  }

  function full(file: string) {
    if (process.platform !== "win32") return file
    const shell = Filesystem.windowsPath(file)
    if (path.win32.dirname(shell) !== ".") {
      if (shell.startsWith("/") && name(shell) === "bash") return gitbash() || shell
      return shell
    }
    return Bun.which(shell) || shell
  }

  function pick() {
    const pwsh = Bun.which("pwsh")
    if (pwsh) return pwsh
    const powershell = Bun.which("powershell")
    if (powershell) return powershell
  }

  function select(file: string | undefined, opts?: { acceptable?: boolean }) {
    if (file && (!opts?.acceptable || !BLACKLIST.has(name(file)))) return full(file)
    if (process.platform === "win32") {
      const shell = pick()
      if (shell) return shell
    }
    return fallback()
  }

  export function gitbash() {
    if (process.platform !== "win32") return
    if (Flag.OPENCODE_GIT_BASH_PATH) return Flag.OPENCODE_GIT_BASH_PATH
    const git = which("git")
    if (!git) return
    const file = path.join(git, "..", "..", "bin", "bash.exe")
    if (Filesystem.stat(file)?.size) return file
  }

  function fallback() {
    if (process.platform === "win32") {
      const file = gitbash()
      if (file) return file
      const bash = which("bash")
      if (bash) return bash
      return nativeWindowsShell()
    }
    if (process.platform === "darwin") return "/bin/zsh"
    const bash = which("bash")
    if (bash) return bash
    return "/bin/sh"
  }

  export function name(file: string) {
    if (process.platform === "win32") return path.win32.parse(Filesystem.windowsPath(file)).name.toLowerCase()
    return path.basename(file).toLowerCase()
  }

  export function login(file: string) {
    return LOGIN.has(name(file))
  }

  export function posix(file: string) {
    return POSIX.has(name(file))
  }

  export const preferred = lazy(() => select(process.env.SHELL))

  export const acceptable = lazy(() => select(process.env.SHELL, { acceptable: true }))
  const UNIX_SHELLS = new Set(["bash", "sh", "zsh", "fish", "nu"])

  export function isUnixLike(shell: string): boolean {
    const base = path
      .basename(shell)
      .toLowerCase()
      .replace(/\.exe$/, "")
    return UNIX_SHELLS.has(base)
  }

  export function display(shell: string) {
    return path
      .basename(shell)
      .replace(/\.exe$/i, "")
      .toLowerCase()
  }

  export const pwsh = lazy(() => which("pwsh") ?? undefined)
  export const powershell = lazy(() => which("powershell") ?? which("powershell.exe") ?? undefined)
}
