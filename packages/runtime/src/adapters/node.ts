/**
 * Node.js runtime adapter implementation
 */

import type {
  RuntimeAdapter,
  FileStat,
  FileWriteOptions,
  SpawnOptions,
  SpawnResult,
  ShellOptions,
  ShellResult,
  Subprocess,
  GlobOptions,
  ServeOptions,
  ServerHandle,
  WhichOptions,
} from "../types"

import fs from "node:fs/promises"
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync, execSync } from "node:child_process"
import path from "node:path"

/**
 * Node.js runtime adapter - uses native Node.js APIs
 */
export const NodeAdapter: RuntimeAdapter = {
  name: "node",

  file: {
    async read(filePath: string): Promise<string> {
      return fs.readFile(filePath, "utf-8")
    },

    async readBytes(filePath: string): Promise<Uint8Array> {
      const buffer = await fs.readFile(filePath)
      return new Uint8Array(buffer)
    },

    async write(filePath: string, content: string | Uint8Array, options?: FileWriteOptions): Promise<void> {
      await fs.writeFile(filePath, content, { mode: options?.mode })
    },

    async exists(filePath: string): Promise<boolean> {
      try {
        await fs.access(filePath)
        return true
      } catch {
        return false
      }
    },

    async stat(filePath: string): Promise<FileStat> {
      const stats = await fs.stat(filePath)
      return {
        size: stats.size,
        mtime: stats.mtime,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
      }
    },

    async remove(filePath: string): Promise<void> {
      await fs.unlink(filePath)
    },
  },

  process: {
    spawn(command: string[], options?: SpawnOptions): Subprocess {
      const [cmd, ...args] = command
      const proc = nodeSpawn(cmd!, args, {
        cwd: options?.cwd,
        env: { ...process.env, ...options?.env } as NodeJS.ProcessEnv,
        stdio: [
          options?.stdin === "pipe" ? "pipe" : options?.stdin === "inherit" ? "inherit" : "ignore",
          options?.stdout === "pipe" ? "pipe" : options?.stdout === "inherit" ? "inherit" : "ignore",
          options?.stderr === "pipe" ? "pipe" : options?.stderr === "inherit" ? "inherit" : "ignore",
        ],
        detached: options?.detached,
        shell: options?.shell,
      })

      // Handle abort signal
      if (options?.signal) {
        options.signal.addEventListener("abort", () => {
          proc.kill()
        })
      }

      // Convert Node.js stdin to WritableStream if needed
      let stdinStream: WritableStream<Uint8Array> | null = null
      if (proc.stdin) {
        const stdin = proc.stdin
        stdinStream = new WritableStream({
          write(chunk) {
            return new Promise((resolve, reject) => {
              stdin.write(chunk, (err) => {
                if (err) reject(err)
                else resolve()
              })
            })
          },
          close() {
            stdin.end()
          },
        })
      }

      // Convert Node.js stdout/stderr to ReadableStream if needed
      let stdoutStream: ReadableStream<Uint8Array> | null = null
      if (proc.stdout) {
        const stdout = proc.stdout
        stdoutStream = new ReadableStream({
          start(controller) {
            stdout.on("data", (chunk: Buffer) => {
              controller.enqueue(new Uint8Array(chunk))
            })
            stdout.on("end", () => {
              controller.close()
            })
            stdout.on("error", (err) => {
              controller.error(err)
            })
          },
        })
      }

      let stderrStream: ReadableStream<Uint8Array> | null = null
      if (proc.stderr) {
        const stderr = proc.stderr
        stderrStream = new ReadableStream({
          start(controller) {
            stderr.on("data", (chunk: Buffer) => {
              controller.enqueue(new Uint8Array(chunk))
            })
            stderr.on("end", () => {
              controller.close()
            })
            stderr.on("error", (err) => {
              controller.error(err)
            })
          },
        })
      }

      const exitedPromise = new Promise<number | null>((resolve) => {
        proc.on("exit", (code) => {
          resolve(code)
        })
        proc.on("error", () => {
          resolve(null)
        })
      })

      return {
        pid: proc.pid ?? 0,
        stdin: stdinStream,
        stdout: stdoutStream,
        stderr: stderrStream,
        exited: exitedPromise,
        kill(signal?: number) {
          if (signal !== undefined) {
            proc.kill(signal as unknown as NodeJS.Signals)
          } else {
            proc.kill()
          }
        },
        ref() {
          proc.ref()
        },
        unref() {
          proc.unref()
        },
      }
    },

    spawnSync(command: string[], options?: SpawnOptions): SpawnResult {
      const [cmd, ...args] = command
      const proc = nodeSpawnSync(cmd!, args, {
        cwd: options?.cwd,
        env: { ...process.env, ...options?.env } as NodeJS.ProcessEnv,
        stdio: [
          options?.stdin === "pipe" ? "pipe" : options?.stdin === "inherit" ? "inherit" : "ignore",
          options?.stdout === "pipe" ? "pipe" : options?.stdout === "inherit" ? "inherit" : "ignore",
          options?.stderr === "pipe" ? "pipe" : options?.stderr === "inherit" ? "inherit" : "ignore",
        ],
        shell: options?.shell,
        timeout: options?.timeout,
      })

      return {
        pid: proc.pid ?? 0,
        exitCode: proc.status,
        stdout: proc.stdout?.toString() ?? "",
        stderr: proc.stderr?.toString() ?? "",
        success: proc.status === 0,
      }
    },

    async exec(command: string, options?: ShellOptions): Promise<ShellResult> {
      const proc = nodeSpawnSync(command, {
        cwd: options?.cwd,
        env: { ...process.env, ...options?.env } as NodeJS.ProcessEnv,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: options?.timeout,
      })

      return {
        exitCode: proc.status ?? 1,
        stdout: proc.stdout?.toString() ?? "",
        stderr: proc.stderr?.toString() ?? "",
        success: proc.status === 0,
      }
    },

    which(name: string, options?: WhichOptions): string | null {
      try {
        const pathEnv = options?.PATH ? `${process.env.PATH}${path.delimiter}${options.PATH}` : process.env.PATH
        // Use 'where' on Windows, 'which' on Unix
        const cmd = process.platform === "win32" ? "where" : "which"
        const result = execSync(`${cmd} ${name}`, {
          encoding: "utf-8",
          env: { ...process.env, PATH: pathEnv },
          stdio: ["ignore", "pipe", "ignore"],
        })
        // 'where' on Windows can return multiple lines, take the first
        return result.trim().split(/\r?\n/)[0] || null
      } catch {
        return null
      }
    },

    async resolve(specifier: string, parent: string): Promise<string | undefined> {
      try {
        // Use Node.js module resolution
        const { createRequire } = await import("node:module")
        const require = createRequire(parent)
        return require.resolve(specifier)
      } catch {
        return undefined
      }
    },
  },

  glob: {
    async *scan(pattern: string, options?: GlobOptions): AsyncIterable<string> {
      // Use Node.js built-in glob (Node 20+) or fast-glob as fallback
      const { createRequire } = await import("node:module")
      const require = createRequire(import.meta.url)

      // Try to use fast-glob which is commonly available
      let fg: any
      try {
        fg = require("fast-glob")
      } catch {
        // Fallback to Node.js fs.glob if available (Node 20+)
        const fsPromises = await import("node:fs/promises")
        if ("glob" in fsPromises) {
          const matches = (fsPromises as any).glob(pattern, {
            cwd: options?.cwd ?? ".",
          })
          for await (const entry of matches) {
            yield options?.absolute ? path.resolve(options.cwd ?? ".", entry) : entry
          }
          return
        }
        throw new Error("No glob implementation available. Install fast-glob package.")
      }

      const entries = await fg(pattern, {
        cwd: options?.cwd ?? ".",
        absolute: options?.absolute,
        dot: options?.dot,
        ignore: options?.ignore,
        followSymbolicLinks: options?.followSymlinks,
        onlyFiles: options?.onlyFiles ?? true,
        onlyDirectories: options?.onlyDirectories,
      })

      for (const entry of entries) {
        yield entry
      }
    },

    *scanSync(pattern: string, options?: GlobOptions): Iterable<string> {
      // Use fast-glob sync for Node.js
      const { createRequire } = require("node:module")
      const req = createRequire(import.meta.url)

      let fg: any
      try {
        fg = req("fast-glob")
      } catch {
        throw new Error("No glob implementation available. Install fast-glob package.")
      }

      const entries = fg.sync(pattern, {
        cwd: options?.cwd ?? ".",
        absolute: options?.absolute,
        dot: options?.dot,
        ignore: options?.ignore,
        followSymbolicLinks: options?.followSymlinks,
        onlyFiles: options?.onlyFiles ?? true,
        onlyDirectories: options?.onlyDirectories,
      })

      for (const entry of entries) {
        yield entry
      }
    },

    match(pattern: string, filePath: string): boolean {
      // Use micromatch or picomatch for pattern matching
      const { createRequire } = require("node:module")
      const req = createRequire(import.meta.url)

      let matcher: any
      try {
        matcher = req("micromatch")
        return matcher.isMatch(filePath, pattern)
      } catch {
        try {
          matcher = req("picomatch")
          return matcher(pattern)(filePath)
        } catch {
          // Simple fallback - just check if pattern equals path
          // This is a very basic implementation
          const regex = new RegExp("^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$")
          return regex.test(filePath)
        }
      }
    },
  },

  server: {
    serve<T>(options: ServeOptions<T>): ServerHandle {
      // For Node.js, we need to use http module
      // This is a simplified implementation - production would need more work
      const http = require("node:http")

      const server = http.createServer(async (req: any, res: any) => {
        // Convert Node.js request to Fetch API Request
        const url = `http://${req.headers.host}${req.url}`
        const headers = new Headers()
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === "string") {
            headers.set(key, value)
          }
        }

        const request = new Request(url, {
          method: req.method,
          headers,
        })

        const remoteAddress = req.socket?.remoteAddress ?? "unknown"
        const response = await options.fetch(request, { remoteAddress })

        res.statusCode = response.status
        response.headers.forEach((value, key) => {
          res.setHeader(key, value)
        })

        const body = await response.text()
        res.end(body)
      })

      const hostname = options.hostname ?? "localhost"
      const port = options.port ?? 0

      server.listen(port, hostname)

      const actualPort = server.address()?.port ?? port

      return {
        port: actualPort,
        hostname,
        url: `http://${hostname}:${actualPort}`,
        stop(closeActiveConnections?: boolean) {
          if (closeActiveConnections) {
            server.closeAllConnections?.()
          }
          server.close()
        },
        upgrade<U>(_request: Request, _opts?: { data?: U }): boolean {
          // WebSocket upgrade not implemented for Node.js yet
          return false
        },
      }
    },
  },

  util: {
    sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms))
    },

    gc(): void {
      if (global.gc) {
        global.gc()
      }
    },

    stringWidth(str: string): number {
      // Simple implementation - count characters
      // For proper Unicode width, would need a library like string-width
      let width = 0
      for (const char of str) {
        const code = char.codePointAt(0) ?? 0
        // Rough heuristic for wide characters (CJK, emojis, etc.)
        if (
          code > 0x1100 &&
          (code <= 0x115f || code === 0x2329 || code === 0x232a || (code >= 0x2e80 && code <= 0xa4cf))
        ) {
          width += 2
        } else {
          width += 1
        }
      }
      return width
    },

    async streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      let result = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        result += decoder.decode(value, { stream: true })
      }

      result += decoder.decode()
      return result
    },

    async streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
      const reader = stream.getReader()
      const chunks: Uint8Array[] = []

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }

      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const result = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.length
      }

      return result
    },

    async stdinText(): Promise<string> {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) {
        chunks.push(chunk)
      }
      return Buffer.concat(chunks).toString("utf-8")
    },
  },
}
