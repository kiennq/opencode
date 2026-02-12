// Entry point dispatcher: runs the worker or the CLI based on env var.
// In child process mode (OPENCODE_WORKER_MODE=1), we import only the
// worker module to avoid loading CLI dependencies.
// We delete the env var immediately so nested opencode invocations
// (e.g. running opencode from within a TUI session) start as CLI, not worker.
const worker = process.env.OPENCODE_WORKER_MODE
delete process.env.OPENCODE_WORKER_MODE
if (worker) {
  await import("./cli/cmd/tui/worker")
} else {
  await import("./index")
}
