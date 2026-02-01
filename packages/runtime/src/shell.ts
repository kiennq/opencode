/**
 * Shell command execution abstraction
 *
 * Provides a cross-runtime shell execution API similar to Bun's $ template tag.
 */

import { Process } from "./process"

// Buffer polyfill for Deno compatibility
const BufferClass =
  typeof Buffer !== "undefined"
    ? Buffer
    : class FakeBuffer extends Uint8Array {
        override toString(encoding?: string): string {
          return new TextDecoder(encoding === "utf8" || encoding === "utf-8" ? "utf-8" : encoding).decode(this)
        }
      }

export interface ShellOutput {
  readonly exitCode: number
  readonly stdout: Buffer
  readonly stderr: Buffer
  text(encoding?: BufferEncoding): string
  json(): any
  arrayBuffer(): ArrayBuffer
  bytes(): Uint8Array
  blob(): Blob
}

export interface ShellPromise extends Promise<ShellOutput> {
  /**
   * Change the current working directory of the shell.
   */
  cwd(newCwd: string): ShellPromise

  /**
   * Set environment variables for the shell.
   */
  env(newEnv: Record<string, string | undefined>): ShellPromise

  /**
   * Suppress stdout/stderr output
   */
  quiet(): ShellPromise

  /**
   * Read from stdout as a string, line by line
   */
  lines(): AsyncIterable<string>

  /**
   * Read from stdout as a string
   */
  text(encoding?: BufferEncoding): Promise<string>

  /**
   * Read from stdout as a JSON object
   */
  json(): Promise<any>

  /**
   * Read from stdout as an ArrayBuffer
   */
  arrayBuffer(): Promise<ArrayBuffer>

  /**
   * Read from stdout as a Blob
   */
  blob(): Promise<Blob>

  /**
   * Configure the shell to not throw an exception on non-zero exit codes.
   */
  nothrow(): ShellPromise

  /**
   * Configure whether or not the shell should throw an exception on non-zero exit codes.
   */
  throws(shouldThrow: boolean): ShellPromise
}

export interface ShellInterface {
  (strings: TemplateStringsArray, ...expressions: unknown[]): ShellPromise

  /**
   * Perform bash-like brace expansion on the given pattern.
   */
  braces(pattern: string): string[]

  /**
   * Escape strings for input into shell commands.
   */
  escape(input: string): string

  /**
   * Change the default environment variables for shells created by this instance.
   */
  env(newEnv?: Record<string, string | undefined>): ShellInterface

  /**
   * Default working directory to use for shells created by this instance.
   */
  cwd(newCwd?: string): ShellInterface

  /**
   * Configure the shell to not throw an exception on non-zero exit codes.
   */
  nothrow(): ShellInterface

  /**
   * Configure whether or not the shell should throw an exception on non-zero exit codes.
   */
  throws(shouldThrow: boolean): ShellInterface
}

interface ShellOptions {
  command: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  quiet?: boolean
  nothrow?: boolean
}

interface ShellDefaults {
  cwd?: string
  env?: Record<string, string | undefined>
  nothrow?: boolean
}

function createOutput(exitCode: number, stdoutBytes: Uint8Array, stderrBytes: Uint8Array): ShellOutput {
  const stdout = typeof Buffer !== "undefined" ? Buffer.from(stdoutBytes) : (stdoutBytes as unknown as Buffer)
  const stderr = typeof Buffer !== "undefined" ? Buffer.from(stderrBytes) : (stderrBytes as unknown as Buffer)

  return {
    exitCode,
    stdout,
    stderr,
    text(encoding?: BufferEncoding): string {
      return new TextDecoder(encoding === "utf8" || encoding === "utf-8" ? "utf-8" : encoding).decode(stdoutBytes)
    },
    json(): any {
      return JSON.parse(this.text())
    },
    arrayBuffer(): ArrayBuffer {
      const sliced = stdoutBytes.buffer.slice(stdoutBytes.byteOffset, stdoutBytes.byteOffset + stdoutBytes.byteLength)
      // Handle SharedArrayBuffer case by copying to ArrayBuffer
      if (sliced instanceof SharedArrayBuffer) {
        const ab = new ArrayBuffer(sliced.byteLength)
        new Uint8Array(ab).set(new Uint8Array(sliced))
        return ab
      }
      return sliced
    },
    bytes(): Uint8Array {
      return stdoutBytes
    },
    blob(): Blob {
      return new Blob([this.arrayBuffer()])
    },
  }
}

class ShellPromiseImpl implements ShellPromise {
  private options: ShellOptions
  private _promise: Promise<ShellOutput> | null = null

  constructor(options: ShellOptions) {
    this.options = { ...options }
  }

  private execute(): Promise<ShellOutput> {
    if (this._promise) return this._promise

    this._promise = (async () => {
      const proc = Process.spawn(this.options.command, {
        cwd: this.options.cwd,
        env: this.options.env ? { ...process.env, ...this.options.env } : undefined,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "inherit",
      })

      // Read stdout and stderr concurrently with process execution
      // We need to start reading BEFORE waiting for exit, otherwise streams may be closed
      const stdoutPromise = proc.stdout ? readStream(proc.stdout) : Promise.resolve(new Uint8Array(0))
      const stderrPromise = proc.stderr ? readStream(proc.stderr) : Promise.resolve(new Uint8Array(0))

      // Wait for process to exit and streams to be fully read
      const [exitCode, stdoutBytes, stderrBytes] = await Promise.all([proc.exited, stdoutPromise, stderrPromise])

      // If not quiet, write to console
      if (!this.options.quiet) {
        if (stdoutBytes.length > 0) {
          process.stdout.write(stdoutBytes)
        }
        if (stderrBytes.length > 0) {
          process.stderr.write(stderrBytes)
        }
      }

      const result = createOutput(exitCode ?? 1, stdoutBytes, stderrBytes)

      // Throw if exit code is non-zero and nothrow is not set
      if (!this.options.nothrow && result.exitCode !== 0) {
        const error = new Error(
          `Command failed with exit code ${result.exitCode}: ${this.options.command.join(" ")}`,
        ) as Error & ShellOutput
        Object.assign(error, result)
        throw error
      }

      return result
    })()

    return this._promise
  }

  then<TResult1 = ShellOutput, TResult2 = never>(
    onfulfilled?: ((value: ShellOutput) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected)
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<ShellOutput | TResult> {
    return this.execute().catch(onrejected)
  }

  finally(onfinally?: (() => void) | null): Promise<ShellOutput> {
    return this.execute().finally(onfinally)
  }

  get [Symbol.toStringTag]() {
    return "ShellPromise"
  }

  nothrow(): ShellPromise {
    return new ShellPromiseImpl({ ...this.options, nothrow: true })
  }

  throws(shouldThrow: boolean): ShellPromise {
    return new ShellPromiseImpl({ ...this.options, nothrow: !shouldThrow })
  }

  quiet(): ShellPromise {
    return new ShellPromiseImpl({ ...this.options, quiet: true })
  }

  cwd(directory: string): ShellPromise {
    return new ShellPromiseImpl({ ...this.options, cwd: directory })
  }

  env(vars: Record<string, string | undefined>): ShellPromise {
    return new ShellPromiseImpl({
      ...this.options,
      env: { ...this.options.env, ...vars },
    })
  }

  async text(encoding?: BufferEncoding): Promise<string> {
    const result = await this.execute()
    return result.text(encoding).trim()
  }

  async json(): Promise<any> {
    const result = await this.execute()
    return result.json()
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const result = await this.execute()
    return result.arrayBuffer()
  }

  async blob(): Promise<Blob> {
    const result = await this.execute()
    return result.blob()
  }

  async *lines(): AsyncIterable<string> {
    const result = await this.execute()
    const text = result.text()
    for (const line of text.split("\n")) {
      yield line
    }
  }
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  // Concatenate chunks
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

/**
 * Parse a shell command string into an array of arguments
 * Handles quoted strings and escapes
 */
function parseCommand(cmd: string): string[] {
  const args: string[] = []
  let current = ""
  let inSingleQuote = false
  let inDoubleQuote = false
  let escape = false

  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i]

    if (escape) {
      current += char
      escape = false
      continue
    }

    if (char === "\\") {
      escape = true
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    if (char === " " && !inSingleQuote && !inDoubleQuote) {
      if (current) {
        args.push(current)
        current = ""
      }
      continue
    }

    current += char
  }

  if (current) {
    args.push(current)
  }

  return args
}

/**
 * Escape a string for safe use in shell commands
 */
function escapeShellArg(input: string): string {
  // If the string contains no special characters, return as-is
  if (/^[a-zA-Z0-9._\-\/=]+$/.test(input)) {
    return input
  }
  // Otherwise, wrap in single quotes and escape any single quotes within
  return "'" + input.replace(/'/g, "'\\''") + "'"
}

/**
 * Simple bash-like brace expansion
 * Supports patterns like: {a,b,c}, {1..5}, file.{txt,md}
 */
function expandBraces(pattern: string): string[] {
  const braceMatch = pattern.match(/^(.*?)\{([^}]+)\}(.*)$/)
  if (!braceMatch) {
    return [pattern]
  }

  const prefix = braceMatch[1] ?? ""
  const content = braceMatch[2] ?? ""
  const suffix = braceMatch[3] ?? ""
  const parts: string[] = []

  // Check for range pattern like {1..5} or {a..z}
  const rangeMatch = content.match(/^(.+)\.\.(.+)$/)
  if (rangeMatch) {
    const start = rangeMatch[1] ?? ""
    const end = rangeMatch[2] ?? ""
    const startNum = parseInt(start, 10)
    const endNum = parseInt(end, 10)

    if (!isNaN(startNum) && !isNaN(endNum)) {
      // Numeric range
      const step = startNum <= endNum ? 1 : -1
      for (let i = startNum; step > 0 ? i <= endNum : i >= endNum; i += step) {
        parts.push(String(i))
      }
    } else if (start.length === 1 && end.length === 1) {
      // Character range
      const startCode = start.charCodeAt(0)
      const endCode = end.charCodeAt(0)
      const step = startCode <= endCode ? 1 : -1
      for (let i = startCode; step > 0 ? i <= endCode : i >= endCode; i += step) {
        parts.push(String.fromCharCode(i))
      }
    } else {
      parts.push(content)
    }
  } else {
    // Comma-separated list
    parts.push(...content.split(","))
  }

  // Recursively expand any remaining braces
  const results: string[] = []
  for (const part of parts) {
    const expanded = expandBraces(prefix + part + suffix)
    results.push(...expanded)
  }

  return results
}

/**
 * Create a shell instance with optional defaults
 */
function createShell(defaults: ShellDefaults = {}): ShellInterface {
  function shell(strings: TemplateStringsArray, ...values: unknown[]): ShellPromise {
    // Build the command string from template
    let command = ""
    for (let i = 0; i < strings.length; i++) {
      command += strings[i]
      if (i < values.length) {
        const value = values[i]
        // Escape and quote values that contain spaces or special characters
        if (typeof value === "string") {
          if (value.includes(" ") || value.includes('"') || value.includes("'")) {
            // Escape double quotes and wrap in double quotes
            command += `"${value.replace(/"/g, '\\"')}"`
          } else {
            command += value
          }
        } else {
          command += String(value)
        }
      }
    }

    const args = parseCommand(command.trim())
    return new ShellPromiseImpl({
      command: args,
      cwd: defaults.cwd,
      env: defaults.env,
      nothrow: defaults.nothrow,
    })
  }

  shell.braces = expandBraces
  shell.escape = escapeShellArg

  shell.env = (newEnv?: Record<string, string | undefined>): ShellInterface => {
    return createShell({ ...defaults, env: { ...defaults.env, ...newEnv } })
  }

  shell.cwd = (newCwd?: string): ShellInterface => {
    return createShell({ ...defaults, cwd: newCwd })
  }

  shell.nothrow = (): ShellInterface => {
    return createShell({ ...defaults, nothrow: true })
  }

  shell.throws = (shouldThrow: boolean): ShellInterface => {
    return createShell({ ...defaults, nothrow: !shouldThrow })
  }

  return shell as ShellInterface
}

/**
 * Shell template tag function
 *
 * Usage:
 * ```typescript
 * const result = await $`git status`.quiet().nothrow()
 * console.log(result.text())
 * ```
 */
export const $: ShellInterface = createShell()

/**
 * Shell namespace for explicit command building
 */
export namespace Shell {
  /**
   * Create a shell command from an array of arguments
   */
  export function command(args: string[]): ShellPromise {
    return new ShellPromiseImpl({ command: args })
  }

  /**
   * Create a shell command from a command string
   */
  export function exec(cmd: string): ShellPromise {
    return new ShellPromiseImpl({ command: parseCommand(cmd) })
  }

  /**
   * Escape a string for safe use in shell commands
   */
  export const escape = escapeShellArg

  /**
   * Perform bash-like brace expansion
   */
  export const braces = expandBraces
}
