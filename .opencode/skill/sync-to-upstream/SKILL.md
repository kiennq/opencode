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
2. Make sure local `dev` is current with `origin/dev` so fork commits are not lost.
3. Rebase onto `upstream/dev`.
4. Resolve conflicts by taking upstream structure where it replaces old implementation details, then re-apply any intentional fork behavior that still matters.
5. Verify the result and push with `--force-with-lease` if the rebase rewrote history.

## Conflict Guidance

- Keep both sides when upstream and fork changes are independent.
- Prefer upstream for broad architectural rewrites, then layer back fork-specific behavior only where it is still required.
- Preserve intentional fork behavior that affects user configuration or supported workflows.

## Fork Decisions To Preserve

- Configured `copilot-auth` plugins must remain allowed after upstream syncs.
- Do not reintroduce logic that filters, skips, or blocks user-configured `copilot-auth` plugins during plugin loading.

## Verification

- Confirm there are no remaining conflict markers.
- Review recent history and the final diff for accidental drops.
- Run the most relevant targeted verification for any behavior touched during conflict resolution.

## Quick Checklist

- [ ] Working tree clean
- [ ] Fetched `origin` and `upstream`
- [ ] Local `dev` includes `origin/dev`
- [ ] No conflict markers remain
- [ ] Targeted verification completed
- [ ] Used `--force-with-lease` only when needed
