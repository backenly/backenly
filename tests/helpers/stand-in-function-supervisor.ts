/**
 * A stand-in for the function supervisor that turns every run away.
 *
 * The real supervisor (lib/services/ai-functions/isolation/function-supervisor.cjs)
 * needs root to start runs under uids of their own, and is exercised as root in
 * tests/unit/function-isolation-root.spec.ts. What a caller does when it is
 * refused needs no root: this listens on a UNIX socket, reads a run's header
 * line, answers with the refusal given, and closes, as the supervisor does.
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

export interface StandInSupervisor {
  socket: string
  /** The header line of each run it was sent, parsed. */
  headers: unknown[]
  /** What it answers from now on. */
  answer(refusal: Record<string, unknown>): void
  use(): void
  close(): Promise<void>
}

export async function startStandInSupervisor(refusal: Record<string, unknown> = BUSY_REFUSAL): Promise<StandInSupervisor> {
  const dir = mkdtempSync(join(tmpdir(), 'backenly-fn-stand-in-'))
  const socket = join(dir, 'supervisor.sock')
  const headers: unknown[] = []
  let answer = refusal
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
      conn.end(`s${JSON.stringify(answer)}\n`)
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
      answer = next
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
