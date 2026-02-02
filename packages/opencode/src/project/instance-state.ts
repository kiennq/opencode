/**
 * Instance state helper - avoids circular dependency with Instance
 *
 * Use this instead of `Instance.state()` when you need to call it at module
 * initialization time. This module can be safely imported without triggering
 * circular dependency issues in Node.js.
 *
 * Usage:
 *   import { instanceState } from "../project/instance-state"
 *   const state = instanceState(() => ({ ... }), disposeCallback)
 */

import { State } from "./state"

/**
 * Create instance-scoped state without requiring Instance at module load time.
 * This is an alias for State.lazy that provides the same functionality as
 * Instance.state but can be called at module initialization time.
 */
export function instanceState<S>(init: () => S, dispose?: (state: Awaited<S>) => Promise<void>): () => S {
  return State.lazy(init, dispose)
}
