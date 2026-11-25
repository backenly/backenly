/**
 * The sandbox task's entry point, bundled to /opt/backenly-import/import-worker.cjs
 * (scripts/build-import-worker.mjs) and run as `node` by the task definition
 * the web registers (lib/import/sandbox.ts). See ./main.ts.
 */

import { runWorker, workerEnv } from './main'

/** However the job ends, the task ends by this time: the control plane stops it soon after anyway. */
const HARD_STOP_MS = 2 * 60 * 60_000 + 10 * 60_000

async function start(): Promise<void> {
  const stop = setTimeout(() => {
    console.error('[ImportWorker] stopped at its hard limit')
    process.exit(75)
  }, HARD_STOP_MS)
  stop.unref()
  // Nothing a source sends is allowed to end the task quietly: say it, then exit.
  process.on('unhandledRejection', (reason) => {
    console.error('[ImportWorker] unhandled rejection:', (reason as Error)?.name ?? typeof reason)
    process.exit(70)
  })
  process.on('uncaughtException', (err) => {
    console.error('[ImportWorker] uncaught exception:', err?.name ?? typeof err)
    process.exit(70)
  })
  let code = 1
  try {
    code = await runWorker(workerEnv())
  } catch (err) {
    // Before the job was known: no secret has been seen, but say only the kind of failure.
    console.error('[ImportWorker] could not start:', (err as Error)?.message?.slice(0, 300) ?? 'unknown error')
    code = 64
  }
  process.exit(code)
}

void start()
