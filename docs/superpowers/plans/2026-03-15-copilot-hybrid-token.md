# Copilot Hybrid Token Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the default GitHub Copilot auth path to one stored device token while keeping anomaly fallback behavior compatible.

**Architecture:** Keep the client switch in `packages/opencode/src/plugin/copilot.ts`, but split the authorize flow by selected client. The GitHub path should use one `COPILOT_CLIENT_ID` device token for chat refresh and usage fallback, while the anomaly path keeps the older optional dual-token behavior.

**Tech Stack:** TypeScript, Bun test, existing Copilot auth plugin, existing usage provider

---

## Chunk 1: Lock auth flow

### Task 1: Cover the default GitHub path

**Files:**

- Modify: `packages/opencode/test/plugin/copilot.test.ts`
- Modify: `packages/opencode/src/plugin/copilot.ts`
- Test: `packages/opencode/test/plugin/copilot.test.ts`

- [ ] **Step 1: Write the failing test**

Add or update a test in `packages/opencode/test/plugin/copilot.test.ts` that covers the default `client: "github"` path. Assert that login starts one device flow with `COPILOT_CLIENT_ID`, stores the device token in `refresh`, leaves `usage` undefined, and does not start a second usage flow.

- [ ] **Step 2: Run the targeted test and confirm failure**

Run from `packages/opencode`:

```bash
bun test test/plugin/copilot.test.ts
```

Expected: the GitHub auth test fails because the current callback still starts two device flows and stores a usage token.

- [ ] **Step 3: Implement the minimal GitHub-path change**

In `packages/opencode/src/plugin/copilot.ts`, branch the authorize logic by `configuredClient(cfg)`. For `github`, use only `COPILOT_CLIENT_ID`, return `refresh: deviceToken`, keep `access: ""`, keep `expires: 0`, and do not attach `usage`.

- [ ] **Step 4: Re-run the targeted test and confirm pass**

Run from `packages/opencode`:

```bash
bun test test/plugin/copilot.test.ts
```

Expected: the GitHub auth test passes.

- [ ] **Step 5: Commit the first slice**

```bash
git add packages/opencode/src/plugin/copilot.ts packages/opencode/test/plugin/copilot.test.ts
git commit -m "feat: simplify default copilot github auth flow"
```

### Task 2: Keep the anomaly fallback intact

**Files:**

- Modify: `packages/opencode/test/plugin/copilot.test.ts`
- Modify: `packages/opencode/src/plugin/copilot.ts`
- Test: `packages/opencode/test/plugin/copilot.test.ts`

- [ ] **Step 1: Write the failing fallback tests**

Add or keep targeted tests that prove `client: "anomaly"` still starts anomaly main auth plus an optional `COPILOT_CLIENT_ID` usage flow. Cover both the success case with a separate usage token and the non-blocking case where optional usage auth never completes.

- [ ] **Step 2: Run the targeted test and confirm failure if behavior regressed**

Run from `packages/opencode`:

```bash
bun test test/plugin/copilot.test.ts
```

Expected: any regression shows up before changing more code.

- [ ] **Step 3: Implement only the compatibility logic needed**

Keep the existing anomaly path behavior in `packages/opencode/src/plugin/copilot.ts`. Preserve enterprise handling, preserve optional background persistence of `usage`, and keep refresh writes from dropping an existing anomaly `usage` token.

- [ ] **Step 4: Re-run the targeted test and confirm pass**

Run from `packages/opencode`:

```bash
bun test test/plugin/copilot.test.ts
```

Expected: GitHub single-token tests and anomaly fallback tests all pass together.

- [ ] **Step 5: Commit the fallback slice**

```bash
git add packages/opencode/src/plugin/copilot.ts packages/opencode/test/plugin/copilot.test.ts
git commit -m "feat: preserve anomaly copilot fallback auth"
```

---

## Chunk 2: Update usage path

### Task 3: Make usage fall back to refresh

**Files:**

- Modify: `packages/opencode/src/usage/providers/github-copilot.ts`
- Modify: `packages/opencode/test/server/usage-copilot.test.ts`
- Test: `packages/opencode/test/server/usage-copilot.test.ts`

- [ ] **Step 1: Write the failing usage tests**

Expand `packages/opencode/test/server/usage-copilot.test.ts` to cover both auth shapes. Assert that `fetchCopilotUsage` uses `usage` when present and falls back to `refresh` when `usage` is missing.

- [ ] **Step 2: Run the targeted test and confirm failure**

Run from `packages/opencode`:

```bash
bun test test/server/usage-copilot.test.ts
```

Expected: the refresh fallback case fails because the provider currently requires `usage`.

- [ ] **Step 3: Implement the minimal provider change**

In `packages/opencode/src/usage/providers/github-copilot.ts`, make `usage` optional in the local auth type and send `auth.usage ?? auth.refresh` in the request header. Do not change token parsing or snapshot fallback behavior.

- [ ] **Step 4: Re-run the targeted test and confirm pass**

Run from `packages/opencode`:

```bash
bun test test/server/usage-copilot.test.ts
```

Expected: both usage-token and refresh-fallback cases pass.

- [ ] **Step 5: Commit the usage slice**

```bash
git add packages/opencode/src/usage/providers/github-copilot.ts packages/opencode/test/server/usage-copilot.test.ts
git commit -m "feat: fallback copilot usage auth to refresh token"
```

---

## Chunk 3: Verify compatibility

### Task 4: Keep refresh and schema behavior safe

**Files:**

- Modify: `packages/opencode/test/plugin/copilot.test.ts`
- Inspect: `packages/opencode/src/auth/service.ts`
- Inspect: `packages/opencode/src/auth/index.ts`
- Test: `packages/opencode/test/plugin/copilot.test.ts`
- Test: `packages/opencode/test/auth/auth.test.ts`

- [ ] **Step 1: Lock the bearer refresh case in tests**

Make sure `packages/opencode/test/plugin/copilot.test.ts` still proves lazy bearer exchange works after the auth split. Assert that refresh uses the stored main token, keeps Copilot integration headers, and writes back refreshed `access` without removing optional anomaly `usage`.

- [ ] **Step 2: Verify schema compatibility stays unchanged**

Confirm `packages/opencode/src/auth/service.ts` and `packages/opencode/src/auth/index.ts` still keep `usage` optional. Do not change those files unless the implementation accidentally made `usage` required somewhere else.

- [ ] **Step 3: Run the focused verification set**

Run from `packages/opencode`:

```bash
bun test test/plugin/copilot.test.ts
bun test test/server/usage-copilot.test.ts
bun test test/auth/auth.test.ts
bun typecheck
```

Expected: all tests pass, and typecheck stays clean.

- [ ] **Step 4: Commit the verification slice**

```bash
git add packages/opencode/test/plugin/copilot.test.ts packages/opencode/test/server/usage-copilot.test.ts
git commit -m "test: cover copilot hybrid token compatibility"
```

---

## Chunk 4: Finish cleanly

### Task 5: Sanity-check the final diff

**Files:**

- Inspect: `packages/opencode/src/plugin/copilot.ts`
- Inspect: `packages/opencode/src/usage/providers/github-copilot.ts`
- Inspect: `packages/opencode/test/plugin/copilot.test.ts`
- Inspect: `packages/opencode/test/server/usage-copilot.test.ts`

- [ ] **Step 1: Review the final behavior against the approved design**

Verify these exact outcomes in the diff: GitHub default uses one stored device token, anomaly keeps optional dual-token fallback, usage requests read `auth.usage ?? auth.refresh`, and refresh stays lazy for chat.

- [ ] **Step 2: Check for accidental scope creep**

Make sure no unrelated provider behavior changed, no auth schema became stricter, and enterprise handling still follows the same client split. Stop and trim the diff if anything outside the approved design moved.

- [ ] **Step 3: Prepare the handoff summary**

Record which tests were added or updated, which exact files changed, and whether anomaly compatibility depended on preserving any existing writes or headers. Hand that note to the reviewer or next agent with the final diff.
