/**
 * A stand-in for the function supervisor that runs nothing.
 *
 * The real supervisor (lib/services/ai-functions/isolation/function-supervisor.cjs)
 * needs root to start runs under uids of their own, and is exercised as root in
 * tests/unit/function-isolation-root.spec.ts. What a caller does when a run is
 * refused, cannot start, or sends what it should not, needs no root: this
 * listens on a UNIX socket, reads a run's header line, answers with what it is
 * given, and closes, as the supervisor does.
 *
 * `use()` points this process's function runs at it (and away from
 * BACKENLY_UNSAFE_LOCAL_FUNCTIONS) until `close()` puts both back. UNIX sockets
 * only: on Windows there is no supervisor, so callers skip.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const BUSY_REFUSAL = {
  type: 'refused',
  busy: true,
  reason: 'every function slot on this server (3) was in use and the queue for one (64) was full',
}

/** A run whose process could not be started, as the supervisor reports one. */
export const START_FAILURE = { type: 'exit', code: null, signal: null, killed: null, stderr: '', error: 'spawn EAGAIN' }

/**
 * What the stand-in answers a run: one supervisor line (`s` + JSON), or raw
 * lines written exactly as given, such as a forged `c` line from a run.
 */
export type StandInAnswer = Record<string, unknown> | { lines: string[] }

export interface StandInSupervisor {
  socket: string
  /** The header line of each run it was sent, parsed. */
  headers: unknown[]
  /** What it answers from now on: one answer for every run, or one per run in turn, the last repeated. */
  answer(next: StandInAnswer | StandInAnswer[]): void
  use(): void
  close(): Promise<void>
}

export async function startStandInSupervisor(first: StandInAnswer | StandInAnswer[] = BUSY_REFUSAL): Promise<StandInSupervisor> {
  const dir = mkdtempSync(join(tmpdir(), 'backenly-fn-stand-in-'))
  const socket = join(dir, 'supervisor.sock')
  const headers: unknown[] = []
  let answers: StandInAnswer[] = Array.isArray(first) ? [...first] : [first]
  const nextAnswer = (): StandInAnswer => (answers.length > 1 ? answers.shift()! : answers[0])
  const written = (a: StandInAnswer) =>
    'lines' in a && Array.isArray(a.lines) ? a.lines.map((l) => `${l}\n`).join('') : `s${JSON.stringify(a)}\n`
  const server = createServer((conn) => {
    let got = ''
    conn.on('error', () => {})
    conn.on('data', (chunk) => {
      if (got.includes('\n')) return
      got += chunk.toString('utf8')
      const nl = got.indexOf('\n')
      if (nl < 0) return
      try {
        headers.push(JSON.parse(got.slice(0, nl)))
      } catch {
        headers.push(null)
      }
      conn.end(written(nextAnswer()))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, () => resolve())
  })

  const env = process.env as Record<string, string | undefined>
  let saved: { flag: string | undefined; socket: string | undefined } | null = null
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete env[name]
    else env[name] = value
  }

  return {
    socket,
    headers,
    answer(next) {
      answers = Array.isArray(next) ? [...next] : [next]
    },
    use() {
      saved ??= { flag: env.BACKENLY_UNSAFE_LOCAL_FUNCTIONS, socket: env.BACKENLY_FN_SOCKET }
      delete env.BACKENLY_UNSAFE_LOCAL_FUNCTIONS
      env.BACKENLY_FN_SOCKET = socket
    },
    async close() {
      if (saved) {
        restore('BACKENLY_UNSAFE_LOCAL_FUNCTIONS', saved.flag)
        restore('BACKENLY_FN_SOCKET', saved.socket)
        saved = null
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
