# Runtime Abstraction & Deno Migration Plan

## Goal

Migrate from Bun to Deno runtime for Windows binary to resolve severe memory leak issues on Windows.

## Completed Work

### 1. Runtime Abstraction Layer (`packages/runtime/`)

- [x] Core types: `RuntimeAdapter`, `FileStat`, `SpawnOptions`, `Subprocess`, `GlobOptions`, `ServeOptions`
- [x] File namespace: `read`, `readBytes`, `write`, `exists`, `stat`, `remove`
- [x] Process namespace: `spawn`, `spawnSync`, `exec`, `which`
- [x] Glob namespace: `scan`, `scanSync`, `match`
- [x] Server namespace: `serve`
- [x] Util namespace: `sleep`, `gc`, `stringWidth`, `streamToText`, `streamToBytes`
- [x] Bun adapter implementation (`src/adapters/bun.ts`)
- [x] Deno adapter implementation (`src/adapters/deno.ts`)

### 2. Deno Build Infrastructure

- [x] `packages/opencode/deno.json` - Deno configuration with import maps
- [x] `packages/opencode/script/build-deno.ts` - Cross-platform compile script
- [x] `packages/opencode/src/deno-entry.ts` - Deno entry point

## Next Steps (TODO)

### Phase 1: Migrate Core Utilities

1. **Migrate `packages/opencode/src/bun/index.ts`**
   - Replace `Bun.file()`, `Bun.write()` with `File.read()`, `File.write()`
   - Replace `Bun.spawn()` with `Process.spawn()`
   - Replace `Bun.which()` with `Process.which()`

2. **Migrate file operations across codebase**
   - Search: `Bun.file(` - ~100+ usages
   - Search: `Bun.write(` - ~100+ usages
   - Replace with `File.*` from runtime package

3. **Migrate process operations**
   - Search: `Bun.spawn(` - ~29 usages
   - Search: `Bun.spawnSync(` - usages
   - Replace with `Process.*` from runtime package

4. **Migrate glob operations**
   - Search: `new Bun.Glob(` - ~26 usages
   - Replace with `Glob.*` from runtime package

5. **Migrate utility operations**
   - Search: `Bun.sleep(` - ~20 usages
   - Search: `Bun.which(` - ~71 usages
   - Search: `Bun.readableStreamToText(` - ~12 usages
   - Replace with `Util.*` and `Process.which()` from runtime package

6. **Migrate shell operations**
   - Search: `$ ` from "bun" - ~100+ usages of shell DSL
   - Replace with `Process.exec()` or refactor

### Phase 2: Handle Native Dependencies

1. **PTY Solution**
   - Current: `bun-pty` (Bun-specific native module)
   - Options:
     - Use `node-pty` with Deno FFI
     - Use Deno's native subprocess with PTY flags
     - Create abstraction in runtime package: `Pty.spawn()`

2. **Tree-sitter / Parser Worker**
   - Current: Uses Bun's worker with `@opentui/core/parser.worker.js`
   - Need to adapt for Deno workers

3. **SolidJS Plugin**
   - Current: `@opentui/solid/bun-plugin`
   - For Deno: Use esbuild with solid plugin directly

### Phase 3: Build System

1. **Update `script/build-deno.ts`**
   - Handle npm dependencies via `npm:` specifier
   - Bundle with esbuild before `deno compile`
   - Test cross-compilation for all targets

2. **CI/CD Updates**
   - Add Deno build job to `.github/workflows/monthly-build.yml`
   - Parallel builds: Bun (Linux/macOS) + Deno (Windows)

### Phase 4: Testing

1. **Unit tests for runtime package**
   - Test each adapter independently
   - Test API compatibility between adapters

2. **Integration tests**
   - Run opencode with Deno on Windows
   - Monitor memory usage over extended sessions
   - Compare with Bun memory behavior

## File Migration Checklist

High-priority files to migrate (most Bun API usage):

- [ ] `src/bun/index.ts` - Core Bun utilities
- [ ] `src/tool/bash.ts` - Shell/process execution
- [ ] `src/util/fs.ts` - File system operations
- [ ] `src/pty/index.ts` - PTY handling (needs special attention)
- [ ] `src/lsp/client.ts` - LSP subprocess management
- [ ] `src/mcp/client.ts` - MCP subprocess management
- [ ] `src/session/index.ts` - Session file operations
- [ ] `src/config/index.ts` - Config file operations

## Architecture Notes

### Runtime Detection

```typescript
import { Runtime } from "@opencode-ai/runtime"

// Auto-detect and initialize
await Runtime.init()

// Or specify adapter
import { DenoAdapter } from "@opencode-ai/runtime/adapters/deno"
await Runtime.init(DenoAdapter)
```

### API Usage Pattern

```typescript
import { File, Process, Glob, Util } from "@opencode-ai/runtime"

// Instead of: Bun.file(path).text()
const content = await File.read(path)

// Instead of: Bun.spawn(["cmd", ...args])
const proc = Process.spawn(["cmd", ...args])

// Instead of: new Bun.Glob("**/*.ts").scan()
for await (const file of Glob.scan("**/*.ts")) { ... }

// Instead of: Bun.sleep(1000)
await Util.sleep(1000)
```

## References

- Deno compile docs: https://deno.land/manual/tools/compiler
- Deno npm compatibility: https://deno.land/manual/node/npm_specifiers
- node-pty for Deno: https://github.com/nicholasguo/node-pty-deno (if available)
