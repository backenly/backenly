/**
 * Where a Firebase import writes: the new Backenly project the runner made.
 *
 *   Tables   CREATE_TABLE through the governed kernel (executeAction), declared
 *            exactly (`asWritten`: no guessed UNIQUE, CHECK or foreign key from a
 *            column's name, and `sqlType` so a Firestore `user_id` string stays
 *            text), then closed with an explicit admin_only rule: only the
 *            server key reads or writes an imported table until the person
 *            approves a rule for it, and the auto-RLS reconciler never reopens a
 *            rule someone chose. The planned tables are one governed change, so
 *            History shows the import's tables as one entry and a failure part
 *            way puts the project back to empty (as lib/import/pg-engine.ts does).
 *   Rows     batched INSERTs on the project's own database (its region's pool),
 *            in a transaction that acts as the service role, since the tables
 *            are closed. ON CONFLICT DO NOTHING keeps a re-read page harmless.
 *            Row data never reaches a log or a change record: the copy runs
 *            outside the SQL recorder the change ledger reads.
 *   Users    one governed change: ENABLE_AUTH (the users table, the signing
 *            secret, email sign-in shown as on), and the columns provider
 *            sign-in already uses (oauth_provider, oauth_id, avatar_url) plus
 *            email_verified and firebase_uid. Then rows, as the service role.
 *   Files    one governed change: bucket `files`, private, its type and size
 *            rules opened so any file Firebase held can arrive (executables stay
 *            refused). Then each file through the storage service, which keeps
 *            the plan's quota.
 *
 * Heavy modules load on first use, so the driver's tests never pull the
 * executor or a database client in; they hand the driver a fake of this
 * interface (__tests__/import/firebase-driver.test.ts).
 */

import type { PoolClient } from 'pg'
import type { ColumnType, PlannedColumn, TablePlan } from './firebase-schema'
import type { ImportedUser } from './firebase-users'

export interface FileUpload {
  name: string
  buffer: Buffer
  mimeType: string | null
}

export interface UploadOutcome {
  ok: boolean
  /** Why it was refused, when it was. */
  code?: string
  message?: string
  /** No later file can succeed either (the plan's storage is full). */
  stop?: boolean
}

export interface FirebaseDestination {
  /**
   * Create tables, each closed to all but the server key; a subcollection's
   * firebase_id is made unique within its parent. One History entry titled
   * `title`. Returns the tables whose per-parent uniqueness could not be added.
   */
  createTables(plans: TablePlan[], title: string): Promise<string[]>
  /** extra_fields, for a table whose documents brought fields the sample never saw. */
  addExtraColumn(table: string): Promise<void>
  /** Rows of `columns`, in order; how many were written. */
  insertRows(table: string, columns: PlannedColumn[], rows: unknown[][]): Promise<number>
  countRows(table: string): Promise<number>
  prepareUsers(): Promise<void>
  insertUsers(users: ImportedUser[]): Promise<number>
  /** Users that arrived from Firebase (firebase_uid set). */
  countImportedUsers(): Promise<number>
  /** The private `files` bucket; its id. */
  prepareFilesBucket(maxFileBytes: number): Promise<string>
  uploadFile(bucketId: string, file: FileUpload): Promise<UploadOutcome>
  close(): Promise<void>
}

/** The executor's words for each column type (it reads sqlType first; type is for its records). */
const ACTION_TYPE: Record<ColumnType, string> = {
  text: 'TEXT',
  bigint: 'BIGINT',
  'double precision': 'DOUBLE PRECISION',
  boolean: 'BOOLEAN',
  timestamptz: 'TIMESTAMPTZ',
  jsonb: 'JSONB',
  uuid: 'UUID',
}

/** At most this many bound values in one INSERT (PostgreSQL allows 65,535). */
const MAX_PARAMS = 30_000
const MAX_ROWS_PER_INSERT = 500

/** A table or column name this driver made (lib/import/drivers/firebase-schema.ts), quoted; anything else refused. */
function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) throw new Error(`Refused an unsafe SQL name: ${name.slice(0, 80)}`)
  return `"${name}"`
}

/** A project's workspace schema (workspace_<uuid>, hyphens and all), quoted; anything else refused. */
function schemaIdent(name: string): string {
  if (!/^workspace_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) {
    throw new Error(`Refused an unsafe schema name: ${name.slice(0, 80)}`)
  }
  return `"${name}"`
}

/** `$n` with the cast its column needs; createdAt/updatedAt fall back to now(). */
function placeholder(col: PlannedColumn, n: number): string {
  const cast = `$${n}::${col.type}`
  if (col.source.kind === 'createTime' || col.source.kind === 'updateTime') return `COALESCE(${cast}, now())`
  return cast
}

/** The executor's CREATE_TABLE parameters for one table. */
export function createTableParams(plan: TablePlan): Record<string, unknown> {
  return {
    tableName: plan.name,
    asWritten: true,
    // A moved-in table brings only what Firestore had: no buckets or columns
    // guessed from its name (a "videos" collection must not get a public bucket).
    noAutoProvision: true,
    columns: plan.createColumns.map((c) => ({
      name: c.name,
      type: ACTION_TYPE[c.type],
      sqlType: c.type,
      ...(c.unique ? { unique: true } : {}),
    })),
  }
}

/** The INSERTs for `rows`, split so each stays under the parameter limit. */
export function buildInserts(
  schema: string,
  table: string,
  columns: PlannedColumn[],
  rows: unknown[][],
): Array<{ sql: string; values: unknown[] }> {
  if (rows.length === 0) return []
  const perInsert = Math.max(1, Math.min(MAX_ROWS_PER_INSERT, Math.floor(MAX_PARAMS / Math.max(1, columns.length))))
  const head = `INSERT INTO ${schemaIdent(schema)}.${ident(table)} (${columns.map((c) => ident(c.name)).join(', ')}) VALUES `
  const out: Array<{ sql: string; values: unknown[] }> = []
  for (let i = 0; i < rows.length; i += perInsert) {
    const chunk = rows.slice(i, i + perInsert)
    const values: unknown[] = []
    const tuples = chunk.map((row) => {
      if (row.length !== columns.length) throw new Error(`A row for ${table} has ${row.length} values for ${columns.length} columns.`)
      return `(${row.map((v, j) => {
        values.push(v)
        return placeholder(columns[j], values.length)
      }).join(', ')})`
    })
    out.push({ sql: `${head}${tuples.join(', ')} ON CONFLICT DO NOTHING`, values })
  }
  return out
}

/** A database error about the destination, in Backenly's words: never a row's value. */
function writeFailed(table: string, err: unknown): Error {
  const code = (err as { code?: string } | null)?.code ?? ''
  const what: Record<string, string> = {
    '22P02': "a value did not fit its column's type",
    '22003': "a number did not fit its column's type",
    '22007': 'a date or time could not be read',
    '22008': 'a date or time was out of range',
    '22021': 'a text value was not valid UTF-8',
    '23505': 'two rows had the same value where it must be unique',
    '42703': 'a column was missing',
    '42P01': 'the table was missing',
    '57014': 'it took too long',
  }
  return new Error(`Copying rows into ${table} failed: ${what[code] ?? (code ? `PostgreSQL error ${code}` : 'the write failed')}.`)
}

export function backenlyDestination(input: { projectId: string; userId: string }): FirebaseDestination {
  const { projectId, userId } = input
  // The project's own schema; schemaIdent refuses it unless the id is a uuid.
  const schema = `workspace_${projectId}`

  async function act(action: string, params: Record<string, unknown>): Promise<void> {
    const { executeAction } = await import('@/lib/ai/minimal-executor')
    // No replanning: a failed step of an import is reported, never rewritten by a model.
    const r: any = await executeAction({ action, params: { ...params, confirmed: true } } as any, projectId, undefined, 0, undefined, false)
    if (!r || r.success === false) {
      const what = String(params.tableName ?? params.bucketName ?? '').trim()
      const why = String(r?.message ?? r?.error ?? 'no reason given').split('\n')[0].replace(/^[✅⛔⚠️\s]+/, '').slice(0, 300)
      throw new Error(`Backenly could not ${action.toLowerCase().replace(/_/g, ' ')}${what ? ` ${what}` : ''}: ${why}`)
    }
  }

  /** Run `fn` as one governed change; a change Backenly had to undo is an error, not a success. */
  async function governed(title: string, fn: () => Promise<void>): Promise<void> {
    const { withGovernedChange } = await import('@/lib/changes/ledger')
    const { change } = await withGovernedChange({ projectId, title }, fn)
    if ((change as any)?.recovery) {
      throw new Error(`${title} did not hold: ${(change as any).recovery.explanation ?? 'Backenly put the project back as it was.'}`)
    }
  }

  async function pool() {
    const { projectPool } = await import('@/lib/data-plane/regional')
    return projectPool(projectId, 'import', { max: 4 })
  }

  /** `fn` inside a transaction that acts as the project's service role. */
  async function asServiceRole<T>(fn: (client: PoolClient) => Promise<T>, readOnly = false): Promise<T> {
    const { rlsSessionSql, rlsSessionParams } = await import('@/lib/services/rls-session')
    const client = await (await pool()).connect()
    try {
      await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN')
      await client.query(rlsSessionSql(), rlsSessionParams({ isServiceRole: true }))
      const out = await fn(client)
      await client.query('COMMIT')
      return out
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  return {
    async createTables(plans, title) {
      const unindexed: string[] = []
      if (plans.length === 0) return unindexed
      await governed(title, async () => {
        for (const plan of plans) {
          await act('CREATE_TABLE', createTableParams(plan))
          await act('SET_PERMISSION', { tableName: plan.name, template: 'admin_only' })
          if (plan.parentTable) {
            try {
              await act('CREATE_INDEX', { tableName: plan.name, columns: ['parent_id', 'firebase_id'], unique: true })
            } catch {
              unindexed.push(plan.name)
            }
          }
        }
      })
      return unindexed
    },

    async addExtraColumn(table) {
      await act('ADD_COLUMN', { tableName: table, columns: [{ name: 'extra_fields', type: 'JSONB', sqlType: 'jsonb' }] })
    },

    async insertRows(table, columns, rows) {
      let written = 0
      for (const stmt of buildInserts(schema, table, columns, rows)) {
        try {
          written += await asServiceRole(async (c) => (await c.query(stmt.sql, stmt.values)).rowCount ?? 0)
        } catch (err) {
          throw writeFailed(table, err)
        }
      }
      return written
    },

    async countRows(table) {
      return asServiceRole(async (c) => {
        const r = await c.query(`SELECT count(*)::bigint::text AS n FROM ${schemaIdent(schema)}.${ident(table)}`)
        return Number(r.rows[0]?.n ?? 0)
      }, true)
    },

    async prepareUsers() {
      const { workspaceRawClient } = await import('@/lib/data-plane/regional')
      const { ensureEmailVerifiedColumn } = await import('@/lib/services/end-user-auth-flows')
      await governed('Turn on sign-in for the users moved from Firebase', async () => {
        await act('ENABLE_AUTH', {})
        // Firebase's verified / unverified carries over: existing rows verified, new rows not.
        await ensureEmailVerifiedColumn(projectId, schema)
        const db = await workspaceRawClient(projectId)
        // The columns provider sign-in links on (server/routes/oauth.ts), and the Firebase uid.
        await db.$executeRawUnsafe(
          `ALTER TABLE ${schemaIdent(schema)}."users"
             ADD COLUMN IF NOT EXISTS oauth_provider TEXT,
             ADD COLUMN IF NOT EXISTS oauth_id TEXT,
             ADD COLUMN IF NOT EXISTS avatar_url TEXT,
             ADD COLUMN IF NOT EXISTS firebase_uid TEXT`,
        )
      })
    },

    async insertUsers(users) {
      if (users.length === 0) return 0
      const { introspectAuthUsersTable } = await import('@/lib/services/end-user-auth-table')
      const t = await introspectAuthUsersTable(projectId, schema)
      const cols: Array<{ name: string; type: string; value: (u: ImportedUser) => unknown; now?: boolean }> = [
        { name: 'email', type: 'text', value: (u) => u.email },
        { name: t.passwordColumn, type: 'text', value: (u) => u.password },
      ]
      const optional: Array<[string | null, string, (u: ImportedUser) => unknown, boolean?]> = [
        ['name', 'text', (u) => u.name],
        ['email_verified', 'boolean', (u) => u.emailVerified],
        ['is_blocked', 'boolean', (u) => u.disabled],
        [t.createdAtColumn, 'timestamptz', (u) => u.createdAt?.toISOString() ?? null, true],
        [t.lastLoginColumn, 'timestamptz', (u) => u.lastLoginAt?.toISOString() ?? null],
        ['oauth_provider', 'text', (u) => u.oauthProvider],
        ['oauth_id', 'text', (u) => u.oauthId],
        ['avatar_url', 'text', (u) => u.avatarUrl],
        ['firebase_uid', 'text', (u) => u.firebaseUid],
      ]
      for (const [name, type, value, now] of optional) {
        if (name && t.columns.has(name)) cols.push({ name, type, value, now })
      }
      let written = 0
      const perInsert = Math.min(MAX_ROWS_PER_INSERT, Math.floor(MAX_PARAMS / cols.length))
      for (let i = 0; i < users.length; i += perInsert) {
        const chunk = users.slice(i, i + perInsert)
        const values: unknown[] = []
        const tuples = chunk.map((u) => `(${cols.map((c) => {
          values.push(c.value(u))
          const p = `$${values.length}::${c.type}`
          return c.now ? `COALESCE(${p}, now())` : p
        }).join(', ')})`)
        const sql =
          `INSERT INTO ${schemaIdent(schema)}."users" (${cols.map((c) => ident(c.name)).join(', ')}) ` +
          `VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`
        try {
          written += await asServiceRole(async (c) => (await c.query(sql, values)).rowCount ?? 0)
        } catch (err) {
          throw writeFailed('users', err)
        }
      }
      return written
    },

    async countImportedUsers() {
      return asServiceRole(async (c) => {
        const r = await c.query(`SELECT count(*)::bigint::text AS n FROM ${schemaIdent(schema)}."users" WHERE firebase_uid IS NOT NULL`)
        return Number(r.rows[0]?.n ?? 0)
      }, true)
    },

    async prepareFilesBucket(maxFileBytes) {
      const { prisma } = await import('@/lib/db/prisma')
      let id = ''
      await governed('Create the files bucket for Firebase Storage', async () => {
        let bucket = await prisma.storageBucket.findFirst({ where: { projectId, name: 'files' }, select: { id: true } })
        if (!bucket) {
          await act('CREATE_BUCKET', { bucketName: 'files', isPublic: false })
          bucket = await prisma.storageBucket.findFirst({ where: { projectId, name: 'files' }, select: { id: true } })
        }
        if (!bucket) throw new Error('Backenly could not create the files bucket.')
        id = bucket.id
        const { governedChange } = await import('@/lib/changes/ledger')
        // Joins the change opened above. Any type Firebase held; private; executables stay refused.
        await governedChange(projectId, 'Let the files bucket take every file moved from Firebase Storage', () =>
          prisma.storageBucket.update({
            where: { id },
            data: { allowedExtensions: [], allowedMimeTypes: [], maxFileSizeBytes: BigInt(maxFileBytes) },
          }),
        )
      })
      return id
    },

    async uploadFile(bucketId, file) {
      const { storageService } = await import('@/lib/services/storage')
      const { isUploadRejected } = await import('@/lib/storage/upload-policy')
      const { consoleUploader } = await import('@/lib/storage/uploader')
      try {
        // Sent by the person running the import, from the console: no end user uploaded it.
        await storageService.uploadFile(
          bucketId,
          { name: file.name, buffer: file.buffer, ...(file.mimeType ? { mimeType: file.mimeType } : {}) },
          { projectId, uploader: consoleUploader(userId) },
        )
        return { ok: true }
      } catch (err) {
        if (isUploadRejected(err)) {
          return { ok: false, code: err.code, message: err.message, stop: err.code === 'STORAGE_QUOTA_EXCEEDED' || err.code === 'BUCKET_NOT_FOUND' }
        }
        throw err
      }
    },

    async close() {
      // The regional pool is shared and kept for the process, like every other.
    },
  }
}
