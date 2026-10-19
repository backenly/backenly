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
import {
  RegionNotConfiguredError,
  projectDriftEvents,
  projectRegion,
  regionDatabaseUrl,
  regionRawClient,
  regionSetting,
  workspaceRawClient,
} from '@/lib/data-plane/regional'
import { HOME_REGION, type CloudRegionId } from '@/lib/regions'
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

interface ConnectionTarget {
  host: string
  port: number
  database: string
  sslmode: string
}

/**
 * Where a developer connects to reach a project's data: the database in the
 * project's region, where its role exists.
 *
 * The home region keeps DIRECT_DB_HOST / DIRECT_DB_PORT and their defaults.
 * Any other region needs its own DIRECT_DB_HOST_<REGION> (DIRECT_DB_PORT_<REGION>
 * optional): without it this refuses, rather than hand out the home host, where
 * the project's role and schema do not exist.
 */
function connectionTargetFor(region: CloudRegionId, projectId: string): ConnectionTarget {
  const isProd = process.env.NODE_ENV === 'production'
  let database = 'backenly'
  try {
    const url = new URL(regionDatabaseUrl(region) ?? '')
    database = url.pathname.replace(/^\//, '').split('?')[0] || 'backenly'
  } catch {
    /* keep default */
  }
  const host = regionSetting('DIRECT_DB_HOST', region)
  if (region !== HOME_REGION && !host.value) {
    throw new RegionNotConfiguredError(region, host.variable, projectId)
  }
  return {
    host: host.value || (isProd ? 'backenly.com' : 'localhost'),
    port: parseInt(regionSetting('DIRECT_DB_PORT', region).value ?? '5432', 10),
    database,
    // Snakeoil cert on the box → require (encrypted, no CA verification). Local
    // dev clusters usually have ssl off, so don't demand it there.
    sslmode: isProd ? 'require' : 'prefer',
  }
}

async function connectionTarget(projectId: string): Promise<ConnectionTarget> {
  return connectionTargetFor(await projectRegion(projectId), projectId)
}

function buildCredential(
  row: { mode: string; roleName: string; passwordCipher: string; passwordIv: string; passwordTag: string; createdAt: Date; rotatedAt: Date | null },
  schema: string,
  target: ConnectionTarget,
): DirectAccessCredential {
  const { host, port, database, sslmode } = target
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
    // --enable-row-security is load-bearing: pg_dump defaults row_security to
    // OFF, and PostgreSQL then refuses to dump any RLS table the NOBYPASSRLS
    // bkn_ro_ role is subject to ("query would be affected by row-level
    // security policy"). With the flag on, the role reads through its
    // pass-through SELECT policy and the dump completes.
    pgDumpCommand: `pg_dump "${connectionString}" --schema="${schema}" --enable-row-security --no-owner --no-privileges > backup.sql`,
    createdAt: row.createdAt.toISOString(),
    rotatedAt: row.rotatedAt ? row.rotatedAt.toISOString() : null,
  }
}

// ── Provision / rotate / revoke ───────────────────────────────────────────────

export async function provisionDirectAccess(projectId: string, mode: DirectAccessMode): Promise<DirectAccessCredential> {
  assertValidProjectId(projectId)
  // Where the developer will connect, settled before any role exists: a
  // region with no public host configured refuses here, not after the fact.
  const target = await connectionTarget(projectId)
  const schema = await resolveWorkspaceSchema(projectId)
  const row = await provisionRole(projectId, mode, schema)
  return buildCredential(row, schema, target)
}

/**
 * Create (or re-key) a project's role and record its credential. Roles are
 * cluster-wide, so it is created on the database holding the project's data,
 * in its region: a role anywhere else could never reach the schema.
 */
async function provisionRole(projectId: string, mode: DirectAccessMode, schema: string) {
  const db = await workspaceRawClient(projectId)
  const names = directAccessRoleNames(projectId)
  const roleName = mode === 'READ_ONLY' ? names.ro : names.rw
  const password = generatePassword()

  // Definer function validates names server-side and is idempotent (re-keys if
  // the role already exists — recovers cleanly from a half-finished provision).
  await db.$queryRaw`SELECT public.backenly_direct_create_role(${roleName}, ${password}, ${schema}, ${mode})`

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

  return row
}

/**
 * The role and password the platform itself connects as for an agent's
 * read-only SQL (lib/mcp/read-query.ts), provisioning the role on first use.
 * No public host is involved: that connection dials the project's database
 * directly, so a region without a developer-facing host still works.
 */
export async function readOnlyLogin(projectId: string): Promise<{ roleName: string; password: string }> {
  assertValidProjectId(projectId)
  const row =
    (await prisma.databaseCredential.findUnique({ where: { projectId_mode: { projectId, mode: 'READ_ONLY' } } })) ??
    (await provisionRole(projectId, 'READ_ONLY', await resolveWorkspaceSchema(projectId)))
  const password = decryptValue({ valueCipher: row.passwordCipher, valueIv: row.passwordIv, valueTag: row.passwordTag })
  return { roleName: row.roleName, password }
}

export async function rotateDirectAccess(projectId: string, mode: DirectAccessMode): Promise<DirectAccessCredential> {
  assertValidProjectId(projectId)
  const existing = await prisma.databaseCredential.findUnique({
    where: { projectId_mode: { projectId, mode } },
  })
  if (!existing) throw new Error(`No ${mode} credential to rotate — provision first.`)

  const target = await connectionTarget(projectId)
  const schema = await resolveWorkspaceSchema(projectId)
  const password = generatePassword()
  // The role lives on the project's database, in its region.
  const db = await workspaceRawClient(projectId)
  await db.$queryRaw`SELECT public.backenly_direct_set_password(${existing.roleName}, ${password})`

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

  return buildCredential(row, schema, target)
}

export async function revokeDirectAccess(projectId: string, mode: DirectAccessMode): Promise<void> {
  assertValidProjectId(projectId)
  const existing = await prisma.databaseCredential.findUnique({
    where: { projectId_mode: { projectId, mode } },
  })
  if (!existing) return

  // Terminates live sessions, drops policies naming the role, reassigns any
  // tables it created to the platform role, then drops it. On the project's
  // database, in its region, where the role is.
  const db = await workspaceRawClient(projectId)
  await db.$queryRaw`SELECT public.backenly_direct_drop_role(${existing.roleName})`
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

/**
 * Whether the privileged SECURITY DEFINER helpers a superuser installs via
 * scripts/setup-direct-access.sql are present in this database.
 *
 * Exists so a caller can decline to attempt what is not installed. Calling
 * provisionDirectAccess without them raises `function ... does not exist`, and
 * Prisma logs every failed query at `error` level before the caller ever sees
 * the exception. Bootstrap ran that path twice on its EXPECTED first run, so a
 * normal install opened with raw Prisma error blocks and read as a crash.
 *
 * A catalog probe rather than a caught failure: the question "is this
 * installed" has a cheap direct answer, and asking it directly is also what
 * lets one clear advisory replace one error block per mode.
 *
 * Per region: each region's database needs its own copy of the helpers.
 */
export async function directAccessHelpersInstalled(region: CloudRegionId = HOME_REGION): Promise<boolean> {
  const rows = await regionRawClient(region).$queryRaw<Array<{ present: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'backenly_direct_create_role'
    ) AS present`
  return rows[0]?.present === true
}

export async function getDirectAccessStatus(projectId: string): Promise<DirectAccessStatus> {
  assertValidProjectId(projectId)
  const [schema, rows, pendingDriftEvents] = await Promise.all([
    resolveWorkspaceSchema(projectId),
    prisma.databaseCredential.findMany({ where: { projectId }, orderBy: { mode: 'asc' } }),
    // Counted in the project's region, where the capture trigger records them.
    projectDriftEvents(projectId).then((events) => events.count({ where: { projectId, status: 'pending' } })),
  ])
  // Only a project that has credentials needs to know where they connect.
  const target = rows.length > 0 ? await connectionTarget(projectId) : null
  return {
    schema,
    credentials: target ? rows.map(r => buildCredential(r, schema, target)) : [],
    pendingDriftEvents,
  }
}

// ── Grants sync — the hook called after DDL, for every project ───────────────
//
// For EVERY project, with or without direct-access credentials, because the
// sync is also where the backup role gets read on the workspace: snapshots run
// pg_dump as that role, and a schema it cannot use fails every one of them.
// With credentials it re-applies grants, ownership normalization, and RLS
// pass-through policies for any table created since the last sync — whichever
// side (platform or external) created it. Without them it grants the backup
// role only, and nothing at all on a database without the helpers.

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

  // The grants are on the project's database, in its region, where its roles are.
  const region = await projectRegion(projectId)
  // Credentials were provisioned through the helpers, so they are there. With
  // none, the database may be one that never installed them (they are optional
  // on a self-hosted install), and then there is nothing to sync.
  if (rows.length === 0 && !(await syncHelperInstalled(region))) return

  const names = directAccessRoleNames(projectId)
  const ro = rows.find(r => r.mode === 'READ_ONLY')?.roleName ?? null
  const rw = rows.find(r => r.mode === 'READ_WRITE')?.roleName ?? null
  const owner = rw ? names.owner : null
  const schema = await resolveWorkspaceSchema(projectId)

  const db = regionRawClient(region, projectId)
  await db.$queryRaw`SELECT public.backenly_direct_sync_schema(${schema}, ${ro}, ${rw}, ${owner})`
}

/**
 * The backup role's read on a workspace schema just created, from its first
 * moment, so its first snapshot works. lib/projects/provision.ts calls this
 * right after CREATE SCHEMA, before the project's row exists: the caller names
 * the region, because projectRegion() reads a project with no row as home.
 * The sync also sets the default privileges that cover each table the
 * application adds to the schema later.
 *
 * Returns false, having granted nothing, on a database without the helpers.
 */
export async function grantWorkspaceBackupAccess(region: CloudRegionId, schema: string): Promise<boolean> {
  if (!(await syncHelperInstalled(region))) return false
  // No direct-access role: the call syncDirectAccessGrants makes for a project
  // without credentials.
  await regionRawClient(region).$queryRaw`SELECT public.backenly_direct_sync_schema(${schema}, NULL, NULL, NULL)`
  return true
}

/**
 * Whether the region's database has backenly_direct_sync_schema. Asked rather
 * than called and caught, because a failed query is logged at error level
 * before the caller sees it (see directAccessHelpersInstalled).
 */
async function syncHelperInstalled(region: CloudRegionId): Promise<boolean> {
  const rows = await regionRawClient(region).$queryRaw<Array<{ present: boolean }>>`
    SELECT to_regprocedure('public.backenly_direct_sync_schema(text,text,text,text)') IS NOT NULL AS present`
  return rows[0]?.present === true
}
