/**
 * Bun runtime adapter implementation
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
} from "../types"

/**
 * Bun runtime adapter - uses native Bun APIs
 */
export const BunAdapter: RuntimeAdapter = {
  name: "bun",

  file: {
    async read(path: string): Promise<string> {
      const file = Bun.file(path)
      return file.text()
    },

    async readBytes(path: string): Promise<Uint8Array> {
      const file = Bun.file(path)
      const buffer = await file.arrayBuffer()
      return new Uint8Array(buffer)
    },

    async write(path: string, content: string | Uint8Array, _options?: FileWriteOptions): Promise<void> {
      await Bun.write(path, content)
    },

    async exists(path: string): Promise<boolean> {
      const file = Bun.file(path)
      return file.exists()
    },

    async stat(path: string): Promise<FileStat> {
      const file = Bun.file(path)
      const exists = await file.exists()
      if (!exists) {
        throw new Error(`ENOENT: no such file or directory, stat '${path}'`)
      }
      // Bun.file doesn't provide full stat, use node:fs for this
      const fs = await import("node:fs/promises")
      const stats = await fs.stat(path)
      return {
        size: stats.size,
        mtime: stats.mtime,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
      }
    },

    async remove(path: string): Promise<void> {
      const fs = await import("node:fs/promises")
      await fs.unlink(path)
    },
  },

  process: {
    spawn(command: string[], options?: SpawnOptions): Subprocess {
      const [cmd, ...args] = command
      const proc = Bun.spawn([cmd!, ...args], {
        cwd: options?.cwd,
        env: options?.env as Record<string, string>,
        stdin: options?.stdin === "pipe" ? "pipe" : options?.stdin === "inherit" ? "inherit" : "ignore",
        stdout: options?.stdout === "pipe" ? "pipe" : options?.stdout === "inherit" ? "inherit" : "ignore",
        stderr: options?.stderr === "pipe" ? "pipe" : options?.stderr === "inherit" ? "inherit" : "ignore",
      })

      // Convert Bun's stdin FileSink to WritableStream if needed
      let stdinStream: WritableStream<Uint8Array> | null = null
      if (proc.stdin && "write" in proc.stdin) {
        const sink = proc.stdin
        stdinStream = new WritableStream({
          write(chunk) {
            sink.write(chunk)
          },
          close() {
            sink.end()
          },
        })
      }

      return {
        pid: proc.pid,
        stdin: stdinStream,
        stdout: proc.stdout as ReadableStream<Uint8Array> | null,
        stderr: proc.stderr as ReadableStream<Uint8Array> | null,
        exited: proc.exited,
        kill(signal?: number) {
          proc.kill(signal)
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
      const proc = Bun.spawnSync([cmd!, ...args], {
        cwd: options?.cwd,
        env: options?.env as Record<string, string>,
        stdin: options?.stdin === "pipe" ? "pipe" : options?.stdin === "inherit" ? "inherit" : "ignore",
        stdout: options?.stdout === "pipe" ? "pipe" : options?.stdout === "inherit" ? "inherit" : "ignore",
        stderr: options?.stderr === "pipe" ? "pipe" : options?.stderr === "inherit" ? "inherit" : "ignore",
      })

      return {
        pid: proc.pid,
        exitCode: proc.exitCode,
        stdout: proc.stdout?.toString() ?? "",
        stderr: proc.stderr?.toString() ?? "",
        success: proc.success,
      }
    },

    async exec(command: string, options?: ShellOptions): Promise<ShellResult> {
      // Use Bun's shell via spawnSync with shell option
      const proc = Bun.spawnSync(["sh", "-c", command], {
        cwd: options?.cwd,
        env: options?.env as Record<string, string>,
        stdout: "pipe",
        stderr: "pipe",
      })

      return {
        exitCode: proc.exitCode,
        stdout: proc.stdout?.toString() ?? "",
        stderr: proc.stderr?.toString() ?? "",
        success: proc.exitCode === 0,
      }
    },

    which(name: string): string | null {
      return Bun.which(name)
    },
  },

  glob: {
    async *scan(pattern: string, options?: GlobOptions): AsyncIterable<string> {
      const glob = new Bun.Glob(pattern)
      const iterator = glob.scan({
        cwd: options?.cwd ?? ".",
        absolute: options?.absolute,
        dot: options?.dot,
        followSymlinks: options?.followSymlinks,
        onlyFiles: options?.onlyFiles ?? true,
      })

      for await (const path of iterator) {
        yield path
      }
    },

    *scanSync(pattern: string, options?: GlobOptions): Iterable<string> {
      const glob = new Bun.Glob(pattern)
      const iterator = glob.scanSync({
        cwd: options?.cwd ?? ".",
        absolute: options?.absolute,
        dot: options?.dot,
        followSymlinks: options?.followSymlinks,
        onlyFiles: options?.onlyFiles ?? true,
      })

      for (const path of iterator) {
        yield path
      }
    },

    match(pattern: string, path: string): boolean {
      const glob = new Bun.Glob(pattern)
      return glob.match(path)
    },
  },

  server: {
    serve<T>(options: ServeOptions<T>): ServerHandle {
      const serverOptions: Parameters<typeof Bun.serve>[0] = {
        port: options.port ?? 0,
        hostname: options.hostname ?? "localhost",
        fetch: options.fetch as (request: Request) => Response | Promise<Response>,
        tls: options.tls,
      }

      // Only add websocket if provided
      if (options.websocket) {
        ;(serverOptions as any).websocket = options.websocket
      }

      const server = Bun.serve(serverOptions)

      return {
        port: server.port ?? 0,
        hostname: server.hostname ?? "localhost",
        stop(closeActiveConnections?: boolean) {
          server.stop(closeActiveConnections)
        },
        upgrade<U>(request: Request, opts?: { data?: U }): boolean {
          return server.upgrade(request, opts as { data: unknown })
        },
      }
    },
  },

  util: {
    sleep(ms: number): Promise<void> {
      return Bun.sleep(ms)
    },

    gc(): void {
      Bun.gc(true)
    },

    stringWidth(str: string): number {
      return Bun.stringWidth(str)
    },

    streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
      return Bun.readableStreamToText(stream)
    },

    async streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
      const buffer = await Bun.readableStreamToArrayBuffer(stream)
      return new Uint8Array(buffer)
    },
  },
}
