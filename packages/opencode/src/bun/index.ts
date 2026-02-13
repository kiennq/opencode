import z from "zod"
import { Global } from "../global"
import { Log } from "../util/log"
import path from "path"
import fs from "fs/promises"
import { Filesystem } from "../util/filesystem"
import { NamedError } from "@opencode-ai/util/error"
import { readableStreamToText } from "bun"
import { Lock } from "../util/lock"
import { PackageRegistry } from "./registry"
import { proxied } from "@/util/proxied"

export namespace BunProc {
  const log = Log.create({ service: "bun" })

  interface PackageJson {
    dependencies?: Record<string, string>
    opencode?: {
      providers?: Record<string, string>
    }
  }

  export async function run(cmd: string[], options?: Bun.SpawnOptions.OptionsObject<any, any, any>) {
    log.info("running", {
      cmd: [which(), ...cmd],
      ...options,
    })
    const result = Bun.spawn([which(), ...cmd], {
      ...options,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...options?.env,
        BUN_BE_BUN: "1",
      },
    })
    const code = await result.exited
    const stdout = result.stdout
      ? typeof result.stdout === "number"
        ? result.stdout
        : await readableStreamToText(result.stdout)
      : undefined
    const stderr = result.stderr
      ? typeof result.stderr === "number"
        ? result.stderr
        : await readableStreamToText(result.stderr)
      : undefined
    log.info("done", {
      code,
      stdout,
      stderr,
    })
    if (code !== 0) {
      throw new Error(`Command failed with exit code ${result.exitCode}`)
    }
    return result
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
    return fs
      .readFile(path.join(Global.Path.cache, "package.json"), "utf-8")
      .then((content) => JSON.parse(content))
      .catch(() => ({}))
  }

  async function writePackageJson(parsed: PackageJson) {
    const pkgJsonPath = path.join(Global.Path.cache, "package.json")
    await Bun.write(pkgJsonPath, JSON.stringify(parsed, null, 2))
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
      await Bun.write(pkgJsonPath, "{}")
    }

    // github:user/repo — the module name is the package.json "name" from the
    // repo, not the repo name. Look up by dependency value to find the cached name.
    if (pkg.startsWith("github:")) {
      const parsed = await readPackageJson()
      const deps = parsed.dependencies ?? {}
      const name = Object.keys(deps).find((k) => deps[k] === pkg)
      if (name) {
        const mod = path.join(Global.Path.cache, "node_modules", name)
        if (await Filesystem.exists(mod)) {
          if (provider) await track(provider, pkg)
          return mod
        }
      }
      const args = ["add", "--force", "--exact", ...(proxied() ? ["--no-cache"] : []), "--cwd", Global.Path.cache, pkg]
      log.info("installing package", { pkg })
      await BunProc.run(args, { cwd: Global.Path.cache }).catch((e) => {
        throw new InstallFailedError({ pkg, version })
      })
      const installed = await readPackageJson()
      const resolved = Object.keys(installed.dependencies ?? {}).find((k) => installed.dependencies![k] === pkg)
      if (!resolved) throw new InstallFailedError({ pkg, version })
      if (provider) await track(provider, pkg)
      return path.join(Global.Path.cache, "node_modules", resolved)
    }

    const mod = path.join(Global.Path.cache, "node_modules", pkg)
    const parsed = await readPackageJson()
    const oldPkg = provider ? parsed.opencode?.providers?.[provider] : undefined
    const switched = oldPkg && oldPkg !== pkg

    const dependencies = parsed.dependencies ?? {}
    const modExists = await Filesystem.exists(mod)
    const cachedVersion = dependencies[pkg]

    if (!modExists || !cachedVersion) {
      // continue to install
    } else if (version !== "latest" && cachedVersion === version) {
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
    } else if (version === "latest") {
      const isOutdated = await PackageRegistry.isOutdated(pkg, cachedVersion, Global.Path.cache)
      if (!isOutdated) {
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
      log.info("Cached version is outdated, proceeding with install", { pkg, cachedVersion })
    }

    // Build command arguments
    const args = [
      "add",
      "--force",
      "--exact",
      // TODO: get rid of this case (see: https://github.com/oven-sh/bun/issues/19936)
      ...(proxied() ? ["--no-cache"] : []),
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
