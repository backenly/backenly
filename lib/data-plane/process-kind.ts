/**
 * Which kind of Backenly process this is: the web (Next.js: the console, the
 * platform APIs and the scheduler) or the runtime (server/index.ts: the public
 * /api/v1 traffic and realtime). Each keeps its own connections, so a cap on
 * them can differ by kind (lib/data-plane/regional.ts dataPoolProcessCap).
 *
 * The runtime says so as it starts (noteProcessKind). Next.js sets
 * NEXT_RUNTIME in its own server. Anything else (a script, a test, a worker)
 * is 'other'.
 */

export type ProcessKind = 'web' | 'runtime' | 'other'

const globalForKind = globalThis as unknown as { backenlyProcessKind?: ProcessKind }

/** Called once by the process's entry point. */
export function noteProcessKind(kind: Exclude<ProcessKind, 'other'>): void {
  globalForKind.backenlyProcessKind = kind
}

export function processKind(env: Readonly<Record<string, string | undefined>> = process.env): ProcessKind {
  const noted = globalForKind.backenlyProcessKind
  if (noted) return noted
  if (env.NEXT_RUNTIME) return 'web'
  return 'other'
}
