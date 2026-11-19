/**
 * Supabase → a new Backenly project: the public schema's tables and rows, Auth
 * users with their passwords, Storage files, and the RLS policies held for
 * approval. lib/import/drivers/pg-common.ts carries the shared Postgres flow.
 *
 * Read-only on Supabase: the database through a READ ONLY transaction over
 * TLS, Storage through GET and list calls.
 */

import type { ImportConnection, ImportPreview, ImportPreviewBucket } from '../contract'
import { ImportInputError, type DriverContext, type ImportDriver, type RunContext } from '../driver'
import { checkProjectUrl, readSnapshot } from '../net'
import { fileRefusal } from '../limits'
import { secretsOf } from '../redact'
import { StorageWalkLimitError, inspectStorage, listBuckets, type StorageSource } from '../supabase-storage'
import { analyze, checkPg, openSource, previewOf, runPg, sourceLabelOf } from './pg-common'

type SupabaseConnection = Extract<ImportConnection, { source: 'supabase' }>

const SCHEMAS = ['public']

/** The Storage half, when both the Project URL and the service_role key were given. */
async function storageOf(connection: SupabaseConnection, secrets: readonly string[]): Promise<StorageSource | null> {
  const url = connection.projectUrl?.trim()
  const key = connection.serviceRoleKey?.trim()
  if (!url && !key) return null
  if (!url) throw new ImportInputError('To move files, add the Project URL too (Project Settings → API).', 'projectUrl')
  if (!key) throw new ImportInputError('To move files, add the service_role key too (Project Settings → API).', 'serviceRoleKey')
  return { origin: await checkProjectUrl(url), key, secrets }
}

const SUPABASE_ONLY = 'Edge functions, cron jobs and database webhooks stay in Supabase; ask your agent to rebuild what your app needs from them.'

export const supabaseDriver: ImportDriver<'supabase'> = {
  source: 'supabase',

  async check(connection, ctx) {
    const secrets = secretsOf(connection)
    const storage = await storageOf(connection, secrets)
    await checkPg(connection.connectionString, { secrets, schemas: SCHEMAS, ctx })
    if (storage) await listBuckets(storage)
  },

  async inspect(connection, ctx: DriverContext): Promise<ImportPreview> {
    const secrets = secretsOf(connection)
    const storage = await storageOf(connection, secrets)
    // The preview's deadline ends the connection, and the statement in flight.
    const { conn, parsed } = await openSource(connection.connectionString, secrets, ctx.signal)
    try {
      const { analysis, label } = await readSnapshot(conn, async (db) => ({
        analysis: await analyze(db, { source: 'supabase', schemas: SCHEMAS, usersMoving: true, withAuth: true, countAll: false, signal: ctx.signal }),
        label: await sourceLabelOf(db, parsed, 'supabase'),
      }))
      // A Storage listing past what one import reads is said as the refusal: leaving files out moves the rest.
      let buckets: ImportPreviewBucket[] | null = null
      let unlisted: string | null = null
      if (storage) {
        try {
          buckets = await inspectStorage(storage, ctx.signal)
        } catch (err) {
          if (!(err instanceof StorageWalkLimitError)) throw err
          unlisted = err.message
        }
      }
      const warnings = [SUPABASE_ONLY]
      if (!storage) warnings.push('Files stay in Supabase: add the Project URL and the service_role key to move Storage too.')
      const preview = previewOf(analysis, { source: 'supabase', sourceLabel: label, buckets, warnings, ctx, user: parsed.user })
      if (!preview.refusal) preview.refusal = unlisted
      if (!preview.refusal && buckets) preview.refusal = fileRefusal(buckets.reduce((s, b) => s + b.bytes, 0), ctx.limits)
      return preview
    } finally {
      await conn.end()
    }
  },

  async run(connection, ctx: RunContext) {
    const secrets = secretsOf(connection)
    const storage = ctx.include.files ? await storageOf(connection, secrets) : null
    const buckets = storage ? await listBuckets(storage) : null
    const result = await runPg({
      source: 'supabase',
      label: 'Supabase',
      connectionString: connection.connectionString,
      schemas: SCHEMAS,
      secrets,
      users: ctx.include.users,
      storage,
      buckets,
      ctx,
    })
    result.warnings.push(SUPABASE_ONLY)
    return result
  },
}
