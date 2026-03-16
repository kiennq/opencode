# Hybrid tokens

Keep GitHub auth simple and compatible.

---

## Align

Approved work keeps `provider.github-copilot.options.client?: "github" | "anomaly"` as the only switch. The default stays `github`.

---

## Explain

The current code still runs two auth shapes inside `packages/opencode/src/plugin/copilot.ts`. It keeps a default GitHub client path and an anomaly fallback path, but the GitHub path still carries an unnecessary second usage token flow.

`packages/opencode/src/usage/providers/github-copilot.ts` also expects a dedicated `usage` token today. That no longer matches the approved GitHub behavior.

---

## Define

For `client: "github"`, use one device flow with `COPILOT_CLIENT_ID`. Store the returned device token only in `refresh`, leave `usage` unset, and keep bearer exchange lazy for chat requests.

When chat needs a bearer token, exchange `refresh` through `copilot_internal/v2/token` and cache the bearer in `access` with its expiry. Keep Copilot integration headers on this GitHub path because they are required for the working flow.

For usage requests on the GitHub path, reuse the same stored device token. `packages/opencode/src/usage/providers/github-copilot.ts` should send `auth.usage ?? auth.refresh`.

---

## Preserve

For `client: "anomaly"`, keep the older fallback behavior. Main auth still uses the anomaly client, and a second Copilot usage token remains optional for compatibility.

If the optional anomaly usage flow fails or hangs, login should still succeed with only the main token. Enterprise behavior should follow the same split, but against the enterprise domain.

Keep `usage` optional in the auth schema. That preserves anomaly compatibility and avoids breaking existing stored auth records.

---

## Watch

The biggest risk is removing the extra GitHub usage flow but forgetting that usage requests still need Copilot-compatible headers and token handling. A smaller risk is accidentally changing anomaly behavior while simplifying the default path.

Another risk is overwriting stored auth during bearer refresh in a way that drops an anomaly `usage` token. Refresh writes should keep optional fields intact.

---

## Verify

Tests should cover the GitHub single-token flow, GitHub usage fallback to `refresh`, anomaly dual-token fallback, and bearer refresh still working. Keep targeted coverage in `packages/opencode/test/plugin/copilot.test.ts` and `packages/opencode/test/server/usage-copilot.test.ts`.
