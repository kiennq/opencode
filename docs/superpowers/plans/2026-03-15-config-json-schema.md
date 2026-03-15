# Config JSON Schema Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate and check in a repo-root `config.json` schema artifact from `Config.Info`, and refresh it through the existing generation flow.

**Architecture:** Keep `packages/opencode/src/config/config.ts` as the single schema source of truth. Reuse the existing `packages/opencode/script/schema.ts <config-out> [tui-out]` CLI, add focused tests around its output contract, and wire `script/generate.ts` to emit `./config.json` so the current generate workflow picks it up automatically.

**Tech Stack:** TypeScript, Bun, Zod JSON Schema generation, Bun test, GitHub Actions

---

## Chunk 1: Lock schema behavior

### Task 1: Cover the schema CLI contract

**Files:**

- Create: `packages/opencode/test/script/schema.test.ts`
- Inspect: `packages/opencode/src/config/config.ts`
- Inspect: `packages/opencode/script/schema.ts`
- Inspect: `packages/console/app/package.json`
- Test: `packages/opencode/test/script/schema.test.ts`

- [ ] **Step 1: Write the failing CLI-output tests**

Add `packages/opencode/test/script/schema.test.ts` with subprocess-style coverage for `packages/opencode/script/schema.ts`. Use temp output files and assert all of these behaviors:

1. Running `bun ./script/schema.ts <config-out>` writes a config schema file.
2. Running `bun ./script/schema.ts <config-out> <tui-out>` still writes both files, preserving the current `<config-out> [tui-out]` contract used by `packages/console/app/package.json`.
3. The config schema includes `allowComments` and `allowTrailingCommas`.
4. A known explicit key from `Config.Info` such as `username` appears under `properties`.
5. An open-ended section such as `agent`, `mode`, or `permission` still stays open-ended in emitted JSON Schema via `additionalProperties`, instead of becoming fully closed.

- [ ] **Step 2: Run the targeted test and confirm the baseline**

Run from `packages/opencode`:

```bash
bun test test/script/schema.test.ts
```

Expected: the new test file runs and gives you a clear baseline for the current CLI contract before wiring repo generation.

- [ ] **Step 3: Fix only contract gaps if the test exposes any**

If the new test shows a real mismatch, make the smallest change in `packages/opencode/script/schema.ts` needed to keep the current CLI shape and raw JSON output stable. Do not change argument order, do not remove optional TUI generation, and do not post-process away `allowComments` or `allowTrailingCommas`.

- [ ] **Step 4: Re-run the targeted test and confirm pass**

Run from `packages/opencode`:

```bash
bun test test/script/schema.test.ts
```

Expected: the CLI contract, explicit-property behavior, and open-ended `catchall` behavior all pass.

---

## Chunk 2: Wire repo generation

### Task 2: Add repo-root schema generation to the shared flow

**Files:**

- Modify: `script/generate.ts`
- Modify: `script/generate-lib.ts`
- Modify: `packages/opencode/test/script/generate-lib.test.ts`
- Create: `config.json`
- Test: `packages/opencode/test/script/generate-lib.test.ts`

- [ ] **Step 1: Write the failing generation-flow test**

Expand `packages/opencode/test/script/generate-lib.test.ts` so it covers the command list used by `script/generate.ts`. Add an assertion for a helper that returns the schema-generation command for repo root, for example `bun ./packages/opencode/script/schema.ts ./config.json`, while keeping the existing format helper assertion intact.

- [ ] **Step 2: Run the targeted test and confirm failure**

Run from `packages/opencode`:

```bash
bun test test/script/generate-lib.test.ts
```

Expected: the new assertion fails because the helper for repo-root `config.json` generation does not exist yet.

- [ ] **Step 3: Implement the minimal shared-command change**

In `script/generate-lib.ts`, add a small helper for the schema-generation command. In `script/generate.ts`, call that helper so generation now does three things in order: regenerate the JS SDK, regenerate `packages/sdk/openapi.json`, and regenerate repo-root `config.json` through the existing `packages/opencode/script/schema.ts` CLI.

Do not inline a different schema-generation path in `script/generate.ts`. Keep the CLI reuse explicit so `packages/console/app/package.json` and repo-root generation both depend on the same entrypoint.

- [ ] **Step 4: Re-run the targeted test and confirm pass**

Run from `packages/opencode`:

```bash
bun test test/script/generate-lib.test.ts
```

Expected: the helper test passes and the generate flow still keeps its existing command contract.

- [ ] **Step 5: Generate and check in the artifact**

Run from repo root:

```bash
./script/generate.ts
```

Expected: repo-root `config.json` is created or refreshed as generated output. Do not hand-edit this file; it should be written only by the generator.

---

## Chunk 3: Verify automation

### Task 3: Prove drift resistance and workflow coverage

**Files:**

- Inspect: `config.json`
- Inspect: `.github/workflows/generate.yml`
- Inspect: `packages/console/app/package.json`
- Inspect: `packages/opencode/src/config/config.ts`
- Test: `packages/opencode/test/script/schema.test.ts`

- [ ] **Step 1: Verify the checked-in artifact shape**

Inspect `config.json` and confirm it matches raw schema output from `packages/opencode/script/schema.ts`. Specifically confirm `allowComments`, `allowTrailingCommas`, explicit `properties`, and open-ended `additionalProperties` sections are present where expected.

- [ ] **Step 2: Verify the workflow path stays unchanged**

Inspect `.github/workflows/generate.yml` and confirm it still runs `./script/generate.ts` with no separate schema step. This is the compatibility check that proves future workflow runs will pick up `config.json` changes automatically through the existing auto-commit job.

- [ ] **Step 3: Run the focused verification set**

Run these commands:

From `packages/opencode`:

```bash
bun test test/script/schema.test.ts
bun test test/script/generate-lib.test.ts
bun typecheck
```

From repo root:

```bash
./script/generate.ts
git diff -- config.json script/generate.ts script/generate-lib.ts packages/opencode/script/schema.ts packages/opencode/test/script/schema.test.ts packages/opencode/test/script/generate-lib.test.ts .github/workflows/generate.yml packages/console/app/package.json
```

Expected: tests and typecheck pass, `config.json` exists at repo root, and the diff shows only the intended generation wiring and generated artifact updates.

- [ ] **Step 4: Run the manual regression check from the spec**

Temporarily add one explicit test-only key to `Config.Info` in `packages/opencode/src/config/config.ts`, run `./script/generate.ts`, and confirm the new key appears in repo-root `config.json`. Then remove the temporary key, regenerate again, and confirm the artifact returns to the real schema.

While doing that check, also confirm one open-ended `catchall(z.any())` section still stays open-ended in the emitted schema and does not collapse into a fully enumerated object.

- [ ] **Step 5: Sanity-check CLI compatibility one more time**

Run the existing console-facing command shape manually from repo root:

```bash
bun ./packages/opencode/script/schema.ts ./config.json ./packages/console/app/.output/public/tui.json
```

Expected: the command still accepts `<config-out> [tui-out]` exactly as before. If you do not want to leave build output behind, point the second path at a temp file instead, but keep the same argument shape.
