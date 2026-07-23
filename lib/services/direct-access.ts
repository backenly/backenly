/**
 * DIRECT DATABASE ACCESS — the open-loop service
 * ================================================
 * Hands developers real PostgreSQL connection strings scoped to their own
 * workspace schema, without giving the app CREATEROLE or weakening the
 * governance kernel:
 *
 *   READ_ONLY  (bkn_ro_<hex12>) — SELECT on every workspace table/sequence.
 *               psql, TablePlus, EXPLAIN, BI tools, self-serve pg_dump.
 *               Cannot mutate anything: no INSERT/UPDATE/DELETE/DDL grants.
 *   READ_WRITE (bkn_rw_<hex12>) — DML + in-schema DDL. Every DDL statement it
 *               runs is captured by the backenly_ddl_watch event trigger into
 *               SchemaDriftEvent, and the autonomy loop adopts or flags it
 *               (see lib/autonomy/drift-watch.ts). Reconciliation, not lockout.
 *
 * Every privileged operation is delegated to a SECURITY DEFINER function
 * installed by scripts/setup-direct-access.sql (owned by postgres, hard input
 * validation, EXECUTE granted to backenly_user only). This module never builds
 * role DDL itself.
 *
 * Passwords are AES-256-GCM encrypted at rest (projectEnvCrypto) so the
 * dashboard can re-show the connection string. Rotation terminates live
 * sessions server-side.
 */

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { resolveWorkspaceSchema } from '@/lib/services/workspace-pool'
import { assertValidProjectId } from '@/lib/security/workspace-schema'
import { encryptValue, decryptValue } from '@/lib/security/projectEnvCrypto'

export type DirectAccessMode = 'READ_ONLY' | 'READ_WRITE'

export interface DirectAccessCredential {
  mode: DirectAccessMode
  roleName: string
  password: string
  host: string
  port: number
  database: string
  connectionString: string
  psqlCommand: string
  pgDumpCommand: string
  createdAt: string
  rotatedAt: string | null
}

export interface DirectAccessStatus {
  schema: string
  credentials: DirectAccessCredential[]
  pendingDriftEvents: number
}

// ── Naming ────────────────────────────────────────────────────────────────────

/** Deterministic, opaque per-project role names (rolnames are cluster-visible). */
export function directAccessRoleNames(projectId: string): { ro: string; rw: string; owner: string } {
  assertValidProjectId(projectId)
  const hex = crypto.createHash('sha256').update(projectId).digest('hex').slice(0, 12)
  return { ro: `bkn_ro_${hex}`, rw: `bkn_rw_${hex}`, owner: `bkn_own_${hex}` }
}

function generatePassword(): string {
  // 24 random bytes → 32 chars base64url: URL-safe (no encoding surprises in
  // connection strings) and satisfies the definer function's length floor.
  return crypto.randomBytes(24).toString('base64url')
}

// ── Connection info ───────────────────────────────────────────────────────────

function connectionHost(): { host: string; port: number; database: string; sslmode: string } {
  const fromEnv = process.env.DIRECT_DB_HOST
  const isProd = process.env.NODE_ENV === 'production'
  let database = 'backenly'
  try {
    const url = new URL(process.env.DATABASE_URL ?? '')
    database = url.pathname.replace(/^\//, '').split('?')[0] || 'backenly'
  } catch {
    /* keep default */
  }
  return {
    host: fromEnv || (isProd ? 'backenly.com' : 'localhost'),
    port: parseInt(process.env.DIRECT_DB_PORT ?? '5432', 10),
    database,
    // Snakeoil cert on the box → require (encrypted, no CA verification). Local
    // dev clusters usually have ssl off, so don't demand it there.
    sslmode: isProd ? 'require' : 'prefer',
  }
}

function buildCredential(
  row: { mode: string; roleName: string; passwordCipher: string; passwordIv: string; passwordTag: string; createdAt: Date; rotatedAt: Date | null },
  schema: string,
): DirectAccessCredential {
  const { host, port, database, sslmode } = connectionHost()
  const password = decryptValue({ valueCipher: row.passwordCipher, valueIv: row.passwordIv, valueTag: row.passwordTag })
  const connectionString = `postgresql://${row.roleName}:${password}@${host}:${port}/${database}?sslmode=${sslmode}`
  return {
    mode: row.mode as DirectAccessMode,
    roleName: row.roleName,
    password,
    host,
    port,
    database,
    connectionString,
    // search_path is pinned per-role server-side, so plain psql lands in the
    // project's schema — `\dt` just works.
    psqlCommand: `psql "${connectionString}"`,
    pgDumpCommand: `pg_dump "${connectionString}" --schema="${schema}" --no-owner --no-privileges > backup.sql`,
    createdAt: row.createdAt.toISOString(),
    rotatedAt: row.rotatedAt ? row.rotatedAt.toISOString() : null,
  }
}

// ── Provision / rotate / revoke ───────────────────────────────────────────────

export async function provisionDirectAccess(projectId: string, mode: DirectAccessMode): Promise<DirectAccessCredential> {
  assertValidProjectId(projectId)
  const schema = await resolveWorkspaceSchema(projectId)
  const names = directAccessRoleNames(projectId)
  const roleName = mode === 'READ_ONLY' ? names.ro : names.rw
  const password = generatePassword()

  // Definer function validates names server-side and is idempotent (re-keys if
  // the role already exists — recovers cleanly from a half-finished provision).
  await prisma.$queryRaw`SELECT public.backenly_direct_create_role(${roleName}, ${password}, ${schema}, ${mode})`

  const enc = encryptValue(password)
  const row = await prisma.databaseCredential.upsert({
    where: { projectId_mode: { projectId, mode } },
    create: {
      projectId,
      mode,
      roleName,
      passwordCipher: enc.valueCipher,
      passwordIv: enc.valueIv,
      passwordTag: enc.valueTag,
    },
    update: {
      roleName,
      passwordCipher: enc.valueCipher,
      passwordIv: enc.valueIv,
      passwordTag: enc.valueTag,
      rotatedAt: new Date(),
    },
  })

  await syncDirectAccessGrants(projectId)

  await prisma.auditLog.create({
    data: {
      projectId,
      action: 'DIRECT_ACCESS_PROVISIONED',
      type: 'security',
      details: JSON.stringify({ mode, roleName }),
      timestamp: new Date(),
    },
  }).catch(() => {})

  return buildCredential(row, schema)
}

export async function rotateDirectAccess(projectId: string, mode: DirectAccessMode): Promise<DirectAccessCredential> {
  assertValidProjectId(projectId)
  const existing = await prisma.databaseCredential.findUnique({
    where: { projectId_mode: { projectId, mode } },
  })
  if (!existing) throw new Error(`No ${mode} credential to rotate — provision first.`)

  const schema = await resolveWorkspaceSchema(projectId)
  const password = generatePassword()
  await prisma.$queryRaw`SELECT public.backenly_direct_set_password(${existing.roleName}, ${password})`

  const enc = encryptValue(password)
  const row = await prisma.databaseCredential.update({
    where: { id: existing.id },
    data: {
      passwordCipher: enc.valueCipher,
      passwordIv: enc.valueIv,
      passwordTag: enc.valueTag,
      rotatedAt: new Date(),
    },
  })

  await prisma.auditLog.create({
    data: {
      projectId,
      action: 'DIRECT_ACCESS_ROTATED',
      type: 'security',
      details: JSON.stringify({ mode, roleName: existing.roleName }),
      timestamp: new Date(),
    },
  }).catch(() => {})

  return buildCredential(row, schema)
}

export async function revokeDirectAccess(projectId: string, mode: DirectAccessMode): Promise<void> {
  assertValidProjectId(projectId)
  const existing = await prisma.databaseCredential.findUnique({
    where: { projectId_mode: { projectId, mode } },
  })
  if (!existing) return

  // Terminates live sessions, drops policies naming the role, reassigns any
  // tables it created to the platform role, then drops it.
  await prisma.$queryRaw`SELECT public.backenly_direct_drop_role(${existing.roleName})`
  await prisma.databaseCredential.delete({ where: { id: existing.id } })

  await prisma.auditLog.create({
    data: {
      projectId,
      action: 'DIRECT_ACCESS_REVOKED',
      type: 'security',
      details: JSON.stringify({ mode, roleName: existing.roleName }),
      timestamp: new Date(),
    },
  }).catch(() => {})
}

// ── Status ────────────────────────────────────────────────────────────────────

export async function getDirectAccessStatus(projectId: string): Promise<DirectAccessStatus> {
  assertValidProjectId(projectId)
  const [schema, rows, pendingDriftEvents] = await Promise.all([
    resolveWorkspaceSchema(projectId),
    prisma.databaseCredential.findMany({ where: { projectId }, orderBy: { mode: 'asc' } }),
    prisma.schemaDriftEvent.count({ where: { projectId, status: 'pending' } }),
  ])
  return {
    schema,
    credentials: rows.map(r => buildCredential(r, schema)),
    pendingDriftEvents,
  }
}

// ── Grants sync — the hook the kernel calls after every DDL mutation ─────────
//
// Idempotent and cheap when the project has no direct-access credentials (one
// indexed query, then return). With credentials it re-applies grants, ownership
// normalization, and RLS pass-through policies for any table created since the
// last sync — whichever side (platform or external) created it.

export async function syncDirectAccessGrants(projectId: string): Promise<void> {
  try {
    assertValidProjectId(projectId)
  } catch {
    return // non-workspace callers (invalid ids) are a silent no-op
  }
  const rows = await prisma.databaseCredential.findMany({
    where: { projectId },
    select: { mode: true, roleName: true },
  }).catch(() => [])
  if (rows.length === 0) return

  const names = directAccessRoleNames(projectId)
  const ro = rows.find(r => r.mode === 'READ_ONLY')?.roleName ?? null
  const rw = rows.find(r => r.mode === 'READ_WRITE')?.roleName ?? null
  const owner = rw ? names.owner : null
  const schema = await resolveWorkspaceSchema(projectId)

  await prisma.$queryRaw`SELECT public.backenly_direct_sync_schema(${schema}, ${ro}, ${rw}, ${owner})`
}
