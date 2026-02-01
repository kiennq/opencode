/**
 * Shell command execution abstraction
 *
 * Provides a cross-runtime shell execution API similar to Bun's $ template tag.
 */

import { Runtime } from "./adapter"

export interface ShellExecResult {
  exitCode: number
  stdout: Uint8Array
  stderr: Uint8Array
  /**
   * Get stdout as text
   */
  text(): string
}

export interface ShellCommand {
  /**
   * Execute the command and return the result
   */
  then<T>(
    onfulfilled?: ((value: ShellExecResult) => T | PromiseLike<T>) | null,
    onrejected?: ((reason: unknown) => T | PromiseLike<T>) | null,
  ): Promise<T>

  /**
   * Don't throw on non-zero exit code
   */
  nothrow(): ShellCommand

  /**
   * Alias for nothrow() - matches Bun's API
   */
  throws(shouldThrow: boolean): ShellCommand

  /**
   * Suppress stdout/stderr output
   */
  quiet(): ShellCommand

  /**
   * Set working directory
   */
  cwd(directory: string): ShellCommand

  /**
   * Set environment variables
   */
  env(vars: Record<string, string | undefined>): ShellCommand

  /**
   * Get stdout as text (convenience method)
   */
  text(): Promise<string>

  /**
   * Iterate over stdout lines
   */
  lines(): AsyncIterable<string>
}

interface ShellOptions {
  command: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  quiet?: boolean
  nothrow?: boolean
}

class ShellCommandImpl implements ShellCommand {
  private options: ShellOptions
  private _promise: Promise<ShellExecResult> | null = null

  constructor(options: ShellOptions) {
    this.options = { ...options }
  }

  private execute(): Promise<ShellExecResult> {
    if (this._promise) return this._promise

    this._promise = (async () => {
      const adapter = Runtime.get()
      const proc = adapter.process.spawn(this.options.command, {
        cwd: this.options.cwd,
        env: this.options.env ? { ...process.env, ...this.options.env } : undefined,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "inherit",
      })

      const exitCode = await proc.exited

      // Read stdout and stderr
      const [stdoutBytes, stderrBytes] = await Promise.all([
        proc.stdout ? readStream(proc.stdout) : new Uint8Array(0),
        proc.stderr ? readStream(proc.stderr) : new Uint8Array(0),
      ])

      // If not quiet, write to console
      if (!this.options.quiet) {
        if (stdoutBytes.length > 0) {
          process.stdout.write(stdoutBytes)
        }
        if (stderrBytes.length > 0) {
          process.stderr.write(stderrBytes)
        }
      }

      const result: ShellExecResult = {
        exitCode: exitCode ?? 1,
        stdout: stdoutBytes,
        stderr: stderrBytes,
        text() {
          return new TextDecoder().decode(this.stdout)
        },
      }

      // Throw if exit code is non-zero and nothrow is not set
      if (!this.options.nothrow && result.exitCode !== 0) {
        const error = new Error(
          `Command failed with exit code ${result.exitCode}: ${this.options.command.join(" ")}`,
        ) as Error & { exitCode: number; stdout: Uint8Array; stderr: Uint8Array }
        error.exitCode = result.exitCode
        error.stdout = result.stdout
        error.stderr = result.stderr
        throw error
      }

      return result
    })()

    return this._promise
  }

  then<T>(
    onfulfilled?: ((value: ShellExecResult) => T | PromiseLike<T>) | null,
    onrejected?: ((reason: unknown) => T | PromiseLike<T>) | null,
  ): Promise<T> {
    return this.execute().then(onfulfilled, onrejected)
  }

  nothrow(): ShellCommand {
    return new ShellCommandImpl({ ...this.options, nothrow: true })
  }

  throws(shouldThrow: boolean): ShellCommand {
    return new ShellCommandImpl({ ...this.options, nothrow: !shouldThrow })
  }

  quiet(): ShellCommand {
    return new ShellCommandImpl({ ...this.options, quiet: true })
  }

  cwd(directory: string): ShellCommand {
    return new ShellCommandImpl({ ...this.options, cwd: directory })
  }

  env(vars: Record<string, string | undefined>): ShellCommand {
    return new ShellCommandImpl({
      ...this.options,
      env: { ...this.options.env, ...vars },
    })
  }

  async text(): Promise<string> {
    const result = await this.execute()
    return result.text().trim()
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
 * Shell template tag function
 *
 * Usage:
 * ```typescript
 * const result = await $`git status`.quiet().nothrow()
 * console.log(result.text())
 * ```
 */
export function $(strings: TemplateStringsArray, ...values: unknown[]): ShellCommand {
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
  return new ShellCommandImpl({ command: args })
}

/**
 * Shell namespace for explicit command building
 */
export namespace Shell {
  /**
   * Create a shell command from an array of arguments
   */
  export function command(args: string[]): ShellCommand {
    return new ShellCommandImpl({ command: args })
  }

  /**
   * Create a shell command from a command string
   */
  export function exec(cmd: string): ShellCommand {
    return new ShellCommandImpl({ command: parseCommand(cmd) })
  }
}
