import { Log } from "@/util/log"

export namespace State {
  interface Entry {
    state: any
    dispose?: (state: any) => Promise<void>
  }

  const log = Log.create({ service: "state" })
  const recordsByKey = new Map<string, Map<any, Entry>>()

  /**
   * Registry for the instance directory getter.
   * This is set by Instance at module load time to avoid circular dependency issues.
   * The getter is called at state access time, not at module load time.
   */
  let instanceDirectoryGetter: (() => string) | null = null

  /**
   * Register the instance directory getter.
   * Called by Instance module during initialization.
   */
  export function registerInstanceDirectory(getter: () => string) {
    instanceDirectoryGetter = getter
  }

  /**
   * Get the current instance directory.
   * Throws if called before Instance has registered itself.
   */
  export function getInstanceDirectory(): string {
    if (!instanceDirectoryGetter) {
      throw new Error(
        "Instance directory getter not registered. Ensure Instance module is loaded before accessing state.",
      )
    }
    return instanceDirectoryGetter()
  }

  export function create<S>(root: () => string, init: () => S, dispose?: (state: Awaited<S>) => Promise<void>) {
    return () => {
      const key = root()
      let entries = recordsByKey.get(key)
      if (!entries) {
        entries = new Map<string, Entry>()
        recordsByKey.set(key, entries)
      }
      const exists = entries.get(init)
      if (exists) return exists.state as S
      const state = init()
      entries.set(init, {
        state,
        dispose,
      })
      return state
    }
  }

  /**
   * Create a lazy instance state that doesn't require Instance at module load time.
   * This avoids circular dependency issues in Node.js where Instance might not
   * be fully initialized when modules that depend on it are loaded.
   *
   * Usage: const state = State.lazy(() => ({ ... }), disposeCallback)
   * Access: state() returns the state for the current Instance
   */
  export function lazy<S>(init: () => S, dispose?: (state: Awaited<S>) => Promise<void>): () => S {
    let _state: (() => S) | null = null
    return () => {
      if (!_state) {
        // Use the registered getter instead of importing Instance
        // This avoids circular dependency issues with top-level await
        _state = create(getInstanceDirectory, init, dispose)
      }
      return _state()
    }
  }

  export async function dispose(key: string) {
    const entries = recordsByKey.get(key)
    if (!entries) return

    log.info("waiting for state disposal to complete", { key })

    let disposalFinished = false

    const timer = setTimeout(() => {
      if (!disposalFinished) {
        log.warn(
          "state disposal is taking an unusually long time - if it does not complete in a reasonable time, please report this as a bug",
          { key },
        )
      }
    }, 10000)
    // unref() prevents the timer from keeping the process alive (Node.js/Bun specific)
    if (typeof timer === "object" && timer && "unref" in timer) {
      timer.unref()
    }

    const tasks: Promise<void>[] = []
    for (const [init, entry] of entries) {
      if (!entry.dispose) continue

      const label = typeof init === "function" ? init.name : String(init)

      const task = Promise.resolve(entry.state)
        .then((state) => entry.dispose!(state))
        .catch((error) => {
          log.error("Error while disposing state:", { error, key, init: label })
        })

      tasks.push(task)
    }
    await Promise.all(tasks)

    entries.clear()
    recordsByKey.delete(key)

    disposalFinished = true
    log.info("state disposal completed", { key })
  }
}
