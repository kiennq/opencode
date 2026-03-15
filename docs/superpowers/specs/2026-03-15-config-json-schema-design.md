# Config schema

Keep editor metadata versioned and fresh.

---

## Aim

Add a checked-in repo-root `config.json` JSON Schema artifact for opencode config. Keep it generated from `packages/opencode/src/config/config.ts` so the published schema matches the real input contract.

---

## Describe

`Config.Info` is already the source of truth for config shape, and `packages/opencode/script/schema.ts` already converts it to JSON Schema with `z.toJSONSchema`. The repo currently does not check in the generated result, so `$schema: "https://opencode.ai/config.json"` points at an artifact that is not refreshed by the existing generation flow.

---

## Adopt

Write the generated config schema to repo-root `config.json` and check that file into git. Treat it like `packages/sdk/openapi.json`: generated, versioned, refreshed by automation, and not hand-edited.

Keep repo-root `config.json` as the raw artifact emitted by `packages/opencode/script/schema.ts`, including the existing JSONC metadata flags `allowComments` and `allowTrailingCommas`.

---

## Integrate

Update `script/generate.ts` so it invokes the existing `packages/opencode/script/schema.ts` CLI to write `./config.json` from the repo root. Preserve that CLI contract because `packages/console/app/package.json` already calls the script with explicit output paths.

Keep `.github/workflows/generate.yml` pointed at `./script/generate.ts`, so the current auto-commit job will pick up `config.json` changes without needing a separate workflow step.

---

## Rely

New explicit config options will appear in `config.json` automatically because generation derives from `Config.Info` instead of a hand-maintained list. Any change to the Zod config schema becomes part of the checked-in artifact the next time `./script/generate.ts` runs locally or in CI.

---

## Note

Open-ended sections that use patterns like `catchall(z.any())` should stay open-ended in the emitted JSON Schema. That means the artifact will document known explicit properties where they exist, but it will not fully enumerate dynamic keys in intentionally flexible areas.

---

## Verify

Run `./script/generate.ts` and confirm it updates repo-root `config.json` with the same raw schema shape produced by `schema.ts`, including `allowComments` and `allowTrailingCommas`. Confirm the existing `packages/opencode/script/schema.ts <config-out> [tui-out]` entrypoint still works for `packages/console/app/package.json`.

Add a regression check by introducing a temporary explicit key in `Config.Info`, regenerating, and confirming that key appears in `config.json`. Also verify an open-ended `catchall(z.any())` section stays open-ended in the emitted schema and does not become incorrectly fully enumerated.
