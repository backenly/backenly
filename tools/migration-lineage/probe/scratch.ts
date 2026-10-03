/**
 * Intact SQL replay, into a scratch database and nowhere else.
 *
 * The scratch-database machinery itself now lives in
 * `tools/managed-db/scratch-database.ts`, so the Layer 2 extension provisioner
 * can create a throwaway database without importing this replay path. This file
 * is the replay half, and it is what the production capture must never reach.
 */

import { createHash } from 'node:crypto'
import type { PgClient } from './connect'
import { assertScratchName } from '../../managed-db/scratch-database'

export {
  assertScratchName,
  listScratchDatabases,
  SCRATCH_NAME,
  scratchName,
  withScratchDatabase,
  type ScratchCleanup,
  type ScratchPurpose,
} from '../../managed-db/scratch-database'

export interface ReplayFile {
  name: string
  sql: string
}

export interface ReplayStep {
  name: string
  sha256: string
  bytes: number
  ok: boolean
  ms: number
  error?: { code: string | null; message: string; position: number | null; near: string | null }
}

export interface ReplayReport {
  database: string
  status: 'complete' | 'failed'
  applied: number
  total: number
  steps: ReplayStep[]
}

/**
 * Replay SQL files in order, each submitted whole.
 *
 * `client.query(text)` with no parameters uses the simple query protocol, which
 * accepts several statements in one message and runs them as one implicit
 * transaction. That is what lets a dollar-quoted PL/pgSQL body with semicolons
 * inside it arrive unchanged. The files are never split.
 *
 * Replay stops at the first failure, because every later file may depend on
 * the one that failed; continuing would describe a database no history produced.
 */
export async function replayFiles(client: PgClient, files: ReplayFile[]): Promise<ReplayReport> {
  const [{ database }] = (await client.query('SELECT current_database() AS database')).rows
  assertScratchName(database)

  const steps: ReplayStep[] = []
  for (const file of files) {
    if (/_prisma_migrations/i.test(file.sql)) {
      throw new Error(`${file.name} references _prisma_migrations; this probe never creates a migration ledger`)
    }
    const bytes = Buffer.byteLength(file.sql, 'utf8')
    const sha256 = createHash('sha256').update(file.sql, 'utf8').digest('hex')
    const t0 = Date.now()
    try {
      await client.query(file.sql)
      steps.push({ name: file.name, sha256, bytes, ok: true, ms: Date.now() - t0 })
    } catch (err) {
      const e = err as { code?: string; message?: string; position?: string }
      const position = e.position ? Number(e.position) : null
      steps.push({
        name: file.name,
        sha256,
        bytes,
        ok: false,
        ms: Date.now() - t0,
        error: {
          code: e.code ?? null,
          message: e.message ?? String(err),
          position,
          near: position ? file.sql.slice(Math.max(0, position - 80), position + 40).replace(/\s+/g, ' ') : null,
        },
      })
      break
    }
  }

  const applied = steps.filter(s => s.ok).length
  return { database, status: applied === files.length ? 'complete' : 'failed', applied, total: files.length, steps }
}
