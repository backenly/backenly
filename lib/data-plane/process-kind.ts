/**
 * Which kind of Backenly process this is: the web (Next.js: the console, the
 * platform APIs and the scheduler) or the runtime (server/index.ts: the public
 * /api/v1 traffic and realtime). Each keeps its own connections, so a cap on
 * them can differ by kind (lib/data-plane/regional.ts dataPoolProcessCap).
 *
 * Each says so as it starts (noteProcessKind): the runtime in server/index.ts,
 * the web in instrumentation.ts before it serves. NEXT_RUNTIME in the
 * environment still counts as the web, for a Next server that has it there; a
 * deployed one need not (Next resolves it when it builds the server), and a web
 * that went by it alone ran at the cap meant for 'other'. Anything else (a
 * script, a test, a worker) is 'other'.
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
