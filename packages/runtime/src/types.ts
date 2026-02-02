/**
 * Core types for the runtime abstraction layer
 */

/**
 * File statistics
 */
export interface FileStat {
  size: number
  mtime: Date
  isFile: boolean
  isDirectory: boolean
}

/**
 * Options for file operations
 */
export interface FileWriteOptions {
  mode?: number
  encoding?: "utf-8" | "utf8" | "ascii" | "binary" | "base64" | "hex"
}

/**
 * Options for process spawning
 */
export interface SpawnOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  stdin?: "inherit" | "pipe" | "ignore"
  stdout?: "inherit" | "pipe" | "ignore"
  stderr?: "inherit" | "pipe" | "ignore"
  detached?: boolean
  shell?: boolean | string
  timeout?: number
  signal?: AbortSignal
}

/**
 * Result from spawning a process
 */
export interface SpawnResult {
  pid: number
  exitCode: number | null
  stdout: string
  stderr: string
  success: boolean
}

/**
 * A spawned subprocess handle
 */
export interface Subprocess {
  pid: number
  stdin: WritableStream<Uint8Array> | null
  stdout: ReadableStream<Uint8Array> | null
  stderr: ReadableStream<Uint8Array> | null
  readonly exited: Promise<number | null>
  kill(signal?: number): void
  ref(): void
  unref(): void
}

/**
 * Options for shell command execution
 */
export interface ShellOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  timeout?: number
  quiet?: boolean
  /** If true, don't throw on non-zero exit code */
  nothrow?: boolean
}

/**
 * Options for finding executables
 */
export interface WhichOptions {
  /** Custom PATH to search in (will be appended to existing PATH) */
  PATH?: string
}

/**
 * Result from shell command execution
 */
export interface ShellResult {
  exitCode: number
  stdout: string
  stderr: string
  success: boolean
}

/**
 * Options for glob scanning
 */
export interface GlobOptions {
  cwd?: string
  absolute?: boolean
  dot?: boolean
  ignore?: string[]
  followSymlinks?: boolean
  onlyFiles?: boolean
  onlyDirectories?: boolean
}

/**
 * HTTP server options
 */
export interface ServeOptions<T = unknown> {
  port?: number
  hostname?: string
  fetch: (request: Request, info: { remoteAddress: string }) => Response | Promise<Response>
  websocket?: WebSocketHandler<T>
  tls?: {
    key?: string
    cert?: string
  }
}

/**
 * WebSocket handler for server
 */
export interface WebSocketHandler<T = unknown> {
  message?: (ws: ServerWebSocket<T>, message: string | ArrayBuffer) => void
  open?: (ws: ServerWebSocket<T>) => void
  close?: (ws: ServerWebSocket<T>, code: number, reason: string) => void
  error?: (ws: ServerWebSocket<T>, error: Error) => void
}

/**
 * Server WebSocket connection
 */
export interface ServerWebSocket<T = unknown> {
  data: T
  send(message: string | ArrayBuffer | Uint8Array): void
  close(code?: number, reason?: string): void
  readonly readyState: number
}

/**
 * HTTP server handle
 */
export interface ServerHandle {
  port: number
  hostname: string
  url: string
  stop(closeActiveConnections?: boolean): void
  upgrade<T>(request: Request, options?: { data?: T }): boolean
}

/**
 * Runtime adapter interface - implementations must provide all these
 */
export interface RuntimeAdapter {
  readonly name: "bun" | "node" | "deno"

  // File operations
  file: {
    read(path: string): Promise<string>
    readBytes(path: string): Promise<Uint8Array>
    write(path: string, content: string | Uint8Array, options?: FileWriteOptions): Promise<void>
    exists(path: string): Promise<boolean>
    stat(path: string): Promise<FileStat>
    remove(path: string): Promise<void>
  }

  // Process operations
  process: {
    spawn(command: string[], options?: SpawnOptions): Subprocess
    spawnSync(command: string[], options?: SpawnOptions): SpawnResult
    exec(command: string, options?: ShellOptions): Promise<ShellResult>
    which(name: string, options?: WhichOptions): string | null
    resolve(specifier: string, parent: string): Promise<string | undefined>
  }

  // Glob operations
  glob: {
    scan(pattern: string, options?: GlobOptions): AsyncIterable<string>
    scanSync(pattern: string, options?: GlobOptions): Iterable<string>
    match(pattern: string, path: string): boolean
  }

  // Server operations
  server: {
    serve<T>(options: ServeOptions<T>): ServerHandle
  }

  // Utility operations
  util: {
    sleep(ms: number): Promise<void>
    gc(): void
    stringWidth(str: string): number
    streamToText(stream: ReadableStream<Uint8Array>): Promise<string>
    streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array>
    stdinText(): Promise<string>
  }
}

/**
 * Detect the current runtime environment
 */
export function detectRuntime(): "bun" | "node" | "deno" {
  // Check for Deno first - we may have a Bun stub when running in Deno
  // @ts-ignore - Deno global
  if (typeof Deno !== "undefined") {
    return "deno"
  }
  // @ts-ignore - Bun global
  if (typeof Bun !== "undefined") {
    // Check if this is a stub (our Deno build sets version to "0.0.0-deno")
    // @ts-ignore
    if (Bun.version && Bun.version.includes("deno")) {
      return "deno"
    }
    return "bun"
  }
  return "node"
}
