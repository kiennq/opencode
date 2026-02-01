/**
 * Deno runtime adapter implementation
 *
 * This adapter provides compatibility with Deno runtime.
 * Note: Some features require npm packages that work in Deno via npm: specifier
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

// Declare Deno global for TypeScript
declare const Deno: {
  readTextFile(path: string): Promise<string>
  readFile(path: string): Promise<Uint8Array>
  writeTextFile(path: string, data: string): Promise<void>
  writeFile(path: string, data: Uint8Array): Promise<void>
  stat(path: string): Promise<{ size: number; mtime: Date | null; isFile: boolean; isDirectory: boolean }>
  remove(path: string): Promise<void>
  build: { os: "windows" | "darwin" | "linux" }
  Command: new (
    cmd: string,
    options?: {
      args?: string[]
      cwd?: string
      env?: Record<string, string>
      stdin?: "piped" | "inherit" | "null"
      stdout?: "piped" | "inherit" | "null"
      stderr?: "piped" | "inherit" | "null"
    },
  ) => {
    spawn(): {
      pid: number
      stdin: WritableStream<Uint8Array> | null
      stdout: ReadableStream<Uint8Array> | null
      stderr: ReadableStream<Uint8Array> | null
      status: Promise<{ code: number }>
      kill(signal?: string): void
      ref(): void
      unref(): void
    }
    outputSync(): { code: number; stdout: Uint8Array; stderr: Uint8Array; success: boolean }
    output(): Promise<{ code: number; stdout: Uint8Array; stderr: Uint8Array; success: boolean }>
  }
  serve(options: {
    port?: number
    hostname?: string
    handler: (request: Request) => Response | Promise<Response>
    onListen?: (params: { hostname: string; port: number }) => void
  }): { shutdown(): Promise<void>; finished: Promise<void>; ref(): void; unref(): void }
  readDir(path: string): AsyncIterable<{ name: string; isFile: boolean; isDirectory: boolean; isSymlink: boolean }>
  cwd(): string
  realPathSync(path: string): string
}

/**
 * Simple glob pattern matching
 */
function matchGlob(pattern: string, path: string): boolean {
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "<<<GLOBSTAR>>>")
        .replace(/\*/g, "[^/]*")
        .replace(/<<<GLOBSTAR>>>/g, ".*")
        .replace(/\?/g, ".") +
      "$",
  )
  return regex.test(path)
}

/**
 * Walk directory recursively
 */
async function* walkDir(dir: string, pattern: string, options: GlobOptions): AsyncIterable<string> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      const fullPath = `${dir}/${entry.name}`
      const relativePath = fullPath

      if (entry.isDirectory) {
        // Check if pattern uses globstar
        if (pattern.includes("**")) {
          yield* walkDir(fullPath, pattern, options)
        }
        if (options.onlyDirectories && matchGlob(pattern, relativePath)) {
          yield options.absolute ? Deno.realPathSync(fullPath) : relativePath
        }
      } else if (entry.isFile) {
        if (!options.onlyDirectories && matchGlob(pattern, relativePath)) {
          yield options.absolute ? Deno.realPathSync(fullPath) : relativePath
        }
      }
    }
  } catch {
    // Directory doesn't exist or permission denied
  }
}

/**
 * Deno runtime adapter - uses native Deno APIs
 */
export const DenoAdapter: RuntimeAdapter = {
  name: "deno",

  file: {
    async read(path: string): Promise<string> {
      return Deno.readTextFile(path)
    },

    async readBytes(path: string): Promise<Uint8Array> {
      return Deno.readFile(path)
    },

    async write(path: string, content: string | Uint8Array, _options?: FileWriteOptions): Promise<void> {
      if (typeof content === "string") {
        await Deno.writeTextFile(path, content)
      } else {
        await Deno.writeFile(path, content)
      }
    },

    async exists(path: string): Promise<boolean> {
      try {
        await Deno.stat(path)
        return true
      } catch {
        return false
      }
    },

    async stat(path: string): Promise<FileStat> {
      const info = await Deno.stat(path)
      return {
        size: info.size,
        mtime: info.mtime ?? new Date(0),
        isFile: info.isFile,
        isDirectory: info.isDirectory,
      }
    },

    async remove(path: string): Promise<void> {
      await Deno.remove(path)
    },
  },

  process: {
    spawn(command: string[], options?: SpawnOptions): Subprocess {
      const [cmd, ...args] = command
      const proc = new Deno.Command(cmd!, {
        args,
        cwd: options?.cwd,
        env: options?.env as Record<string, string>,
        stdin: options?.stdin === "pipe" ? "piped" : options?.stdin === "inherit" ? "inherit" : "null",
        stdout: options?.stdout === "pipe" ? "piped" : options?.stdout === "inherit" ? "inherit" : "null",
        stderr: options?.stderr === "pipe" ? "piped" : options?.stderr === "inherit" ? "inherit" : "null",
      }).spawn()

      return {
        pid: proc.pid,
        stdin: proc.stdin,
        stdout: proc.stdout,
        stderr: proc.stderr,
        exited: proc.status.then((s) => s.code),
        kill(signal?: number) {
          // Deno uses string signals, map common ones
          const sigMap: Record<number, string> = { 9: "SIGKILL", 15: "SIGTERM", 2: "SIGINT" }
          proc.kill(sigMap[signal ?? 15] ?? "SIGTERM")
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
      const result = new Deno.Command(cmd!, {
        args,
        cwd: options?.cwd,
        env: options?.env as Record<string, string>,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).outputSync()

      const decoder = new TextDecoder()
      return {
        pid: 0, // Deno sync doesn't expose pid
        exitCode: result.code,
        stdout: decoder.decode(result.stdout),
        stderr: decoder.decode(result.stderr),
        success: result.success,
      }
    },

    async exec(command: string, options?: ShellOptions): Promise<ShellResult> {
      // Use shell to execute command
      const shell = Deno.build.os === "windows" ? "cmd" : "sh"
      const shellArgs = Deno.build.os === "windows" ? ["/c", command] : ["-c", command]

      const result = await new Deno.Command(shell, {
        args: shellArgs,
        cwd: options?.cwd,
        env: options?.env as Record<string, string>,
        stdout: "piped",
        stderr: "piped",
      }).output()

      const decoder = new TextDecoder()
      return {
        exitCode: result.code,
        stdout: decoder.decode(result.stdout),
        stderr: decoder.decode(result.stderr),
        success: result.success,
      }
    },

    which(name: string): string | null {
      // Deno doesn't have a built-in which, use command
      try {
        const shell = Deno.build.os === "windows" ? "where" : "which"
        const result = new Deno.Command(shell, {
          args: [name],
          stdout: "piped",
          stderr: "null",
        }).outputSync()

        if (result.success) {
          const path = new TextDecoder().decode(result.stdout).trim().split("\n")[0]
          return path || null
        }
        return null
      } catch {
        return null
      }
    },
  },

  glob: {
    async *scan(pattern: string, options?: GlobOptions): AsyncIterable<string> {
      const cwd = options?.cwd ?? Deno.cwd()
      const opts: GlobOptions = {
        ...options,
        absolute: options?.absolute ?? false,
        onlyFiles: options?.onlyFiles ?? true,
        onlyDirectories: options?.onlyDirectories ?? false,
      }

      yield* walkDir(cwd, pattern, opts)
    },

    *scanSync(_pattern: string, _options?: GlobOptions): Iterable<string> {
      // Deno doesn't have sync directory reading, throw error
      throw new Error("Synchronous glob scanning is not supported in Deno. Use async scan() instead.")
    },

    match(pattern: string, path: string): boolean {
      return matchGlob(pattern, path)
    },
  },

  server: {
    serve<T>(options: ServeOptions<T>): ServerHandle {
      let serverPort = options.port ?? 0
      let serverHostname = options.hostname ?? "localhost"

      const abortController = new AbortController()

      // Start server asynchronously
      const serverPromise = (async () => {
        const server = Deno.serve({
          port: options.port,
          hostname: options.hostname,
          handler: (req: Request) => options.fetch(req, { remoteAddress: "unknown" }),
          onListen: ({ hostname, port }) => {
            serverPort = port
            serverHostname = hostname
          },
        })
        return server
      })()

      return {
        get port() {
          return serverPort
        },
        get hostname() {
          return serverHostname
        },
        stop(_closeActiveConnections?: boolean) {
          abortController.abort()
          serverPromise.then((s) => s.shutdown())
        },
        upgrade<U>(_request: Request, _opts?: { data?: U }): boolean {
          // WebSocket upgrade would need Deno.upgradeWebSocket
          // This is a simplified implementation
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
      // Deno doesn't expose GC directly
      // Try calling if available (--expose-gc flag)
      if (typeof (globalThis as any).gc === "function") {
        ;(globalThis as any).gc()
      }
    },

    stringWidth(str: string): number {
      // Basic implementation - count characters, treating wide chars as 2
      let width = 0
      for (const char of str) {
        const code = char.codePointAt(0) ?? 0
        // CJK characters and other wide characters
        if (
          (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
          (code >= 0x2e80 && code <= 0xa4cf) || // CJK
          (code >= 0xac00 && code <= 0xd7a3) || // Hangul Syllables
          (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility
          (code >= 0xfe10 && code <= 0xfe6f) || // CJK forms
          (code >= 0xff00 && code <= 0xff60) || // Fullwidth
          (code >= 0xffe0 && code <= 0xffe6) || // Fullwidth
          (code >= 0x20000 && code <= 0x2fffd) || // CJK Extension
          (code >= 0x30000 && code <= 0x3fffd) // CJK Extension
        ) {
          width += 2
        } else if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
          // Control characters
          width += 0
        } else {
          width += 1
        }
      }
      return width
    },

    async streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
      const chunks: Uint8Array[] = []
      const reader = stream.getReader()

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
        }
      } finally {
        reader.releaseLock()
      }

      const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0)
      const result = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.length
      }

      return new TextDecoder().decode(result)
    },

    async streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
      const chunks: Uint8Array[] = []
      const reader = stream.getReader()

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
        }
      } finally {
        reader.releaseLock()
      }

      const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0)
      const result = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.length
      }

      return result
    },
  },
}
