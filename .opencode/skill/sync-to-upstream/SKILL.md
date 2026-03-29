---
name: sync-to-upstream
description: Use when syncing this fork's dev branch with upstream/dev, especially when rebasing, resolving conflicts, or updating the fork after rewritten history.
---

# Sync To Upstream

## Overview

Sync upstream carefully, keep intentional fork behavior, and avoid carrying forward one-off conflict notes that no longer generalize.

## When to Use

- Rebasing `dev` onto `upstream/dev`
- Resolving conflicts during an upstream sync
- Updating `origin/dev` after a rebase

## Prerequisites

- Working tree is clean
- Remotes are correct
- Local `dev` includes the latest `origin/dev` commits before rebasing onto upstream

## Workflow

1. Fetch `origin` and `upstream`.
2. If the user did not name a specific upstream change, review the latest upstream changes first so conflict resolution uses current upstream reality rather than stale assumptions.
3. Make sure local `dev` is current with `origin/dev` so fork commits are not lost.
4. Rebase onto `upstream/dev`.
5. Resolve conflicts by taking upstream structure where it replaces old implementation details, then re-apply any intentional fork behavior that still matters.
6. Verify the result and push with `--force-with-lease` if the rebase rewrote history.

## Autonomy

- If the user asked to sync or rebase onto `upstream/dev`, proceed without asking for confirmation unless blocked by missing access or an irreversible safety issue outside normal rebase/push workflow.
- When upstream was force-pushed or the diff looks unexpectedly large, do not stop just because the change is surprising. Measure the actual commit divergence, continue with best-effort conflict resolution, and preserve fork-only behavior unless it has clearly landed upstream.
- Prefer making the best documented judgment call over pausing for confirmation when the user's standing intent is to complete the sync.

## Conflict Guidance

- Keep both sides when upstream and fork changes are independent.
- Prefer upstream for broad architectural rewrites, then layer back fork-specific behavior only where it is still required.
- Preserve intentional fork behavior that affects user configuration or supported workflows.

## Fork Decisions To Preserve

- Configured `copilot-auth` plugins must remain allowed after upstream syncs.
- Do not reintroduce logic that filters, skips, or blocks user-configured `copilot-auth` plugins during plugin loading.
- Do not reintroduce the removed `experimental.openTelemetry` config or AI SDK `experimental_telemetry` wiring.

## Verification

- Confirm there are no remaining conflict markers.
- Confirm the sync decision used fresh upstream information, especially when no specific upstream change was provided.
- Review recent history and the final diff for accidental drops.
- Run the most relevant targeted verification for any behavior touched during conflict resolution.

## Quick Checklist

- [ ] Working tree clean
- [ ] Fetched `origin` and `upstream`
- [ ] Reviewed latest upstream changes when no specific upstream change was named
- [ ] Local `dev` includes `origin/dev`
- [ ] No conflict markers remain
- [ ] Targeted verification completed
- [ ] Used `--force-with-lease` only when needed
