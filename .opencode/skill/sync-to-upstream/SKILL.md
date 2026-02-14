---
name: sync-to-upstream
description: Use this when rebasing the fork's dev branch onto upstream/dev. Covers fetching, rebasing, conflict resolution strategy, and force-pushing. Applies to the kiennq/opencode fork tracking anomalyco/opencode.
---

## Use this when

- User asks to rebase on upstream, sync with upstream, or pull upstream changes
- Resolving conflicts during rebase onto upstream/dev

## Prerequisites

- Remotes: `origin` = `kiennq/opencode`, `upstream` = `anomalyco/opencode`
- Default branch: `dev` (not main/master)
- Working tree must be clean before rebasing

## Workflow

### 1. Fetch and assess

```bash
git fetch origin --quiet && git fetch upstream --quiet
git log --oneline dev..upstream/dev          # count new commits
git log --oneline --stat dev..upstream/dev -- packages/opencode/  # check for conflict-prone files
```

### 2. Ensure local dev is on top of origin/dev

Before rebasing onto upstream, make sure local `dev` includes all commits from `origin/dev`.
This prevents losing any commits pushed to the fork from other machines or collaborators.

```bash
# If local dev is behind origin/dev, fast-forward first
git merge-base --is-ancestor origin/dev dev || git rebase origin/dev
```

If `origin/dev` has diverged (e.g. after a previous force-push from another machine), reset:

```bash
git reset --hard origin/dev
```

### 3. Rebase onto upstream

```bash
git rebase upstream/dev
```

### 4. Resolve conflicts (if any)

Known conflict-prone areas and resolution strategy:

| File                                         | Our fork changes                                                                                                                       | Resolution strategy                                                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `src/pty/index.ts`                           | Buffer chunk optimization (bufferChunks/bufferSize)                                                                                    | **Take upstream** — their cursor-based reconnection system is more important; our chunk approach is incompatible with cursor tracking |
| `src/session/compaction.ts`                  | Custom thresholds (token_threshold, context_threshold, min_messages), EARLY_COMPACT_RATIO, smart pruning, generateObject for summaries | **Merge both** — keep upstream's primary overflow logic, add our custom threshold early-exits and pruning features                    |
| `src/config/config.ts`                       | memory_threshold for worker recycling, custom compaction threshold fields                                                              | **Merge both** — keep upstream's new fields AND our additions                                                                         |
| `src/session/index.ts`                       | FileTime import, offset pagination, session list merge                                                                                 | **Merge both** — keep all imports from both sides                                                                                     |
| `src/cli/cmd/tui/component/dialog-model.tsx` | Lazy DialogProvider import, PROVIDER_PRIORITY, popularProvidersList memo                                                               | **Take ours** for `popularProvidersList()` since `createDialogProviderOptions` isn't imported in our lazy-import version              |
| `src/provider/transform.ts`                  | Expanded Anthropic detection, whitespace trim                                                                                          | **Merge both** — our detection expansions layer on top of upstream                                                                    |
| `src/tool/bash.ts`                           | Ring buffer (10MB cap)                                                                                                                 | **Take ours** if upstream still uses simple approach; watch for upstream ring buffer adoption                                         |
| `src/question/index.ts`                      | Timeout + rejected event                                                                                                               | **Take ours** if upstream removed timeouts                                                                                            |

General conflict resolution rules:

- **Imports**: Keep all imports from both sides; remove duplicates
- **Config schema fields**: Keep both upstream's new fields AND our additions
- **Core algorithms** (buffer, compaction overflow): Prefer upstream's approach if architecturally different, then layer our custom config options as early-exit checks
- **UI components**: Keep our lazy imports and memo patterns; use upstream's refactored component structure

### 5. After resolving each file

```bash
git add <resolved-files>
git rebase --continue
```

### 6. Verify and push

```bash
git log --oneline -5                                    # verify history looks correct
git push origin dev --force-with-lease --no-verify      # force push
```

If push fails with "stale info" (GitHub 500 during previous push):

```bash
git fetch origin dev --quiet && git push origin dev --force-with-lease --no-verify
```

### 7. Post-rebase checks

- New `.yml` workflow files from upstream need renaming to `.yml.disabled` (we disable upstream CI)
- Pre-push hook may fail on `@opencode-ai/desktop` typecheck due to missing `@tauri-apps/plugin-clipboard-manager` — use `--no-verify` to bypass

## Our fork's architecture (must preserve)

- **Worker recycling via `Bun.spawn`** (NOT upstream's `new Worker()`) — `entry.ts`, `thread.ts`, `worker.ts`, `rpc.ts`
- **`src/entry.ts` dispatcher** — routes to worker or CLI based on `OPENCODE_WORKER_MODE` env var
- **Memory threshold config** — `config.ts` `memory_threshold` field
- **Custom compaction thresholds** — `token_threshold`, `context_threshold`, `min_messages`

## Quick checklist

- [ ] Working tree clean before rebase
- [ ] Fetched both origin and upstream
- [ ] No conflict markers remain after resolution (`rg "<<<<<<|======|>>>>>>"`)
- [ ] Force push with `--force-with-lease --no-verify`
- [ ] Check for new upstream workflow files to disable
