import z from "zod"
import { Global } from "../global"
import { Log } from "../util/log"
import path from "path"
import fs from "fs/promises"
import { Filesystem } from "../util/filesystem"
import { NamedError } from "@opencode-ai/util/error"
import { File, Process, Util } from "@opencode-ai/runtime"
import { Lock } from "../util/lock"

export namespace BunProc {
  const log = Log.create({ service: "bun" })

  interface PackageJson {
    dependencies?: Record<string, string>
    opencode?: {
      providers?: Record<string, string>
    }
  }

  export async function run(cmd: string[], options?: { cwd?: string; env?: Record<string, string> }) {
    log.info("running", {
      cmd: [which(), ...cmd],
      ...options,
    })
    const proc = Process.spawn([which(), ...cmd], {
      ...options,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...options?.env,
        BUN_BE_BUN: "1",
      },
    })
    const code = await proc.exited
    const stdout = proc.stdout ? await Util.streamToText(proc.stdout) : undefined
    const stderr = proc.stderr ? await Util.streamToText(proc.stderr) : undefined
    log.info("done", {
      code,
      stdout,
      stderr,
    })
    if (code !== 0) {
      throw new Error(`Command failed with exit code ${code}`)
    }
    return { exitCode: code, stdout, stderr }
  }

  export function which() {
    return process.execPath
  }

  export const InstallFailedError = NamedError.create(
    "BunInstallFailedError",
    z.object({
      pkg: z.string(),
      version: z.string(),
    }),
  )

  async function readPackageJson(): Promise<PackageJson> {
    const pkgPath = path.join(Global.Path.cache, "package.json")
    try {
      const content = await File.read(pkgPath)
      return JSON.parse(content)
    } catch {
      return {}
    }
  }

  async function writePackageJson(parsed: PackageJson) {
    const pkgPath = path.join(Global.Path.cache, "package.json")
    await File.write(pkgPath, JSON.stringify(parsed, null, 2))
  }

  async function track(provider: string, pkg: string) {
    const parsed = await readPackageJson()
    if (!parsed.opencode) parsed.opencode = {}
    if (!parsed.opencode.providers) parsed.opencode.providers = {}
    parsed.opencode.providers[provider] = pkg
    await writePackageJson(parsed)
  }

  export async function install(pkg: string, version = "latest", provider?: string) {
    using _ = await Lock.write("bun-install")

    // Ensure cache directory exists with a package.json so bun doesn't traverse up
    // to find a parent workspace (e.g., if user has package.json in home directory)
    await fs.mkdir(Global.Path.cache, { recursive: true })
    const pkgJsonPath = path.join(Global.Path.cache, "package.json")
    if (!(await Filesystem.exists(pkgJsonPath))) {
      await File.write(pkgJsonPath, "{}")
    }

    const mod = path.join(Global.Path.cache, "node_modules", pkg)
    const parsed = await readPackageJson()
    const oldPkg = provider ? parsed.opencode?.providers?.[provider] : undefined
    const switched = oldPkg && oldPkg !== pkg

    // Skip install if exact version already cached (always reinstall with "latest")
    const installed = parsed.dependencies?.[pkg]
    if (installed && version !== "latest" && installed === version && (await Filesystem.exists(mod))) {
      if (provider) await track(provider, pkg)
      if (switched) {
        const providers = parsed.opencode?.providers ?? {}
        const used = Object.entries(providers).some(([p, name]) => p !== provider && name === oldPkg)
        if (!used) {
          log.info("removing unused package", { pkg: oldPkg })
          await BunProc.run(["remove", "--cwd", Global.Path.cache, oldPkg]).catch(() => {})
        }
      }
      return mod
    }

    const proxied = !!(
      process.env.HTTP_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.http_proxy ||
      process.env.https_proxy
    )

    const args = [
      "add",
      "--force",
      "--exact",
      // TODO: get rid of this case (see: https://github.com/oven-sh/bun/issues/19936)
      ...(proxied ? ["--no-cache"] : []),
      "--cwd",
      Global.Path.cache,
      pkg + "@" + version,
    ]

    log.info("installing package", { pkg, version })

    await BunProc.run(args, { cwd: Global.Path.cache }).catch((e) => {
      throw new InstallFailedError({ pkg, version }, { cause: e })
    })

    if (provider) await track(provider, pkg)
    if (switched) {
      const current = await readPackageJson()
      const providers = current.opencode?.providers ?? {}
      const used = Object.entries(providers).some(([p, name]) => p !== provider && name === oldPkg)
      if (!used) {
        log.info("removing unused package", { pkg: oldPkg })
        await BunProc.run(["remove", "--cwd", Global.Path.cache, oldPkg!]).catch(() => {})
      }
    }
    return mod
  }
}
