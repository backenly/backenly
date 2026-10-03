/**
 * WRITING A DEPLOYMENT RECOVERY BUNDLE
 * ====================================
 *
 * One file per component, a manifest that says exactly what is inside, and a
 * checksum over each file as written. `lib/recovery/contract.ts` holds the
 * promises; this is what keeps them.
 *
 * ── Why each component is a single file ─────────────────────────────────────
 *
 * A ComponentEntry carries one path and one checksum. A component spread over
 * many files would need either many entries or a checksum over a directory,
 * and a checksum over a directory is a checksum over whatever the walker
 * happened to visit. So every workspace schema goes into ONE pg_dump
 * invocation with repeated --schema flags, and storage objects go into one tar.
 *
 * ── The privileges asymmetry, which is easy to get silently wrong ───────────
 *
 * The platform database is dumped WITHOUT privileges and the workspace schemas
 * WITH them, and the difference is not stylistic.
 *
 * Nothing but the application role touches the platform schema, so its grants
 * carry no information and referencing roles that may not exist on a clean
 * machine only creates restore failures.
 *
 * Workspace schemas are the opposite. `scripts/setup-postgrest-roles.ts` grants
 * USAGE, SELECT, INSERT, UPDATE, DELETE and EXECUTE to anon, authenticated and
 * service_role, and sets ALTER DEFAULT PRIVILEGES so that tables created later
 * inherit them. Dumping those with --no-privileges produces a restore that
 * looks complete and whose data plane returns nothing - and, worse, whose
 * DEFAULT PRIVILEGES are gone, so every table created after the restore is
 * invisible to PostgREST too. That is a failure that would surface days later,
 * attached to nothing.
 *
 * Both are dumped with --no-owner, because ownership is re-established by the
 * role that performs the restore. That role must be the APPLICATION role:
 * workspace tables use FORCE ROW LEVEL SECURITY, which keys on the table owner,
 * so restoring over the backup role would quietly rebind every policy in the
 * deployment. lib/services/workspace-backup.ts records the same reasoning at
 * the point where it chooses a connection.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'
import archiver from 'archiver'
import { prisma } from '@/lib/db/prisma'
import { buildConnection, sanitizeError } from '@/lib/services/workspace-backup'
import {
  BUNDLE_FORMAT_VERSION,
  droppedTableData,
  ENCRYPTED_COMPONENTS,
  RECOVERY_COMPONENTS,
  type ComponentEntry,
  type RecoveryComponent,
  type RecoveryManifest,
} from './contract'
import {
  generateDataKey,
  generateRecoveryCredential,
  sealBuffer,
  sha256,
  wrapDataKey,
} from './crypto'

const execFileAsync = promisify(execFile)

/** Where each component lands inside the bundle. */
export const BUNDLE_FILES: Readonly<Record<RecoveryComponent, string>> = {
  'deployment-metadata': 'metadata.json',
  'platform-database': 'platform.sql.enc',
  'workspace-schemas': 'workspaces.sql.enc',
  'storage-objects': 'storage.tar.enc',
  'function-definitions': 'functions.json.enc',
  'project-secrets': 'secrets.json.enc',
  'operator-ownership': 'ownership.json.enc',
}

export const MANIFEST_FILE = 'manifest.json'

/**
 * pg_dump arguments for the platform database.
 *
 * Exported and pure so the property that matters - that the ephemeral tables
 * actually reach pg_dump - is testable without a database. A classification
 * that never becomes an argument is a comment.
 */
export function platformDumpArgs(): string[] {
  const args = ['--schema', 'public', '--no-owner', '--no-privileges']
  for (const table of droppedTableData().platform) {
    // --exclude-table-data, never --exclude-table: the application expects
    // these tables to exist. They come back empty, not missing.
    args.push(`--exclude-table-data=public.${table}`)
  }
  return args
}

/** pg_dump arguments covering every workspace schema in one invocation. */
export function workspaceDumpArgs(schemas: string[]): string[] {
  const args: string[] = []
  for (const schema of schemas) {
    assertWorkspaceSchemaName(schema)
    args.push('--schema', schema)
  }
  // Privileges deliberately kept. See the header.
  args.push('--no-owner')
  for (const schema of schemas) {
    for (const table of droppedTableData().workspace) {
      args.push(`--exclude-table-data=${schema}.${table}`)
    }
  }
  return args
}

/**
 * Schema names reach pg_dump as arguments, so they are checked rather than
 * trusted, even though they come from pg_namespace rather than from a user.
 */
export function assertWorkspaceSchemaName(schema: string): void {
  if (!/^workspace_[A-Za-z0-9_-]+$/.test(schema)) {
    throw new Error(`Refusing to dump ${JSON.stringify(schema)}: not a workspace schema name.`)
  }
}

export interface ExportOptions {
  /** Directory the bundle is written into. Created if absent. */
  outDir: string
  /**
   * The operator's recovery credential. Generated when absent, and returned
   * once in the result - it is never written into the bundle.
   */
  credential?: string
  /** Storage directory to archive. Defaults to STORAGE_DIR. */
  storageDir?: string
}

export interface ExportResult {
  bundleDir: string
  manifest: RecoveryManifest
  /**
   * Shown to the operator once. Without it the bundle is unopenable, and
   * nothing in the bundle or the database can recover it.
   */
  credential: string
}

interface CollectedComponent {
  component: RecoveryComponent
  content: Buffer
  items: number
}

/** Write a deployment recovery bundle. */
export async function exportDeploymentBundle(options: ExportOptions): Promise<ExportResult> {
  const bundleDir = options.outDir
  const credential = options.credential ?? generateRecoveryCredential()
  const dataKey = generateDataKey()

  await fs.promises.mkdir(/*turbopackIgnore: true*/ bundleDir, { recursive: true })

  const metadata = await collectDeploymentMetadata()
  const collected: CollectedComponent[] = [
    { component: 'deployment-metadata', content: asJson(metadata), items: 1 },
    ...(await collectPlatformDatabase()),
    ...(await collectWorkspaceSchemas()),
    ...(await collectFunctionDefinitions()),
    ...(await collectProjectSecrets()),
    ...(await collectOperatorOwnership()),
    ...(await collectStorageObjects(options.storageDir)),
  ]

  const components: ComponentEntry[] = []
  for (const item of collected) {
    const encrypted = ENCRYPTED_COMPONENTS.includes(item.component)
    const bytes = encrypted ? sealBuffer(item.content, dataKey) : item.content
    const filename = BUNDLE_FILES[item.component]
    await fs.promises.writeFile(
      /*turbopackIgnore: true*/ path.join(bundleDir, filename),
      bytes,
    )
    components.push({
      component: item.component,
      path: filename,
      bytes: bytes.length,
      // Over the file AS WRITTEN, so it can be checked before the credential is
      // ever needed. See the note in crypto.ts on the two integrity checks.
      sha256: sha256(bytes),
      encrypted,
      items: item.items,
    })
  }

  const manifest: RecoveryManifest = {
    formatVersion: BUNDLE_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    backenlyVersion: metadata.backenlyVersion,
    schemaVersion: metadata.schemaVersion,
    postgresVersion: metadata.postgresVersion,
    requiredExtensions: metadata.requiredExtensions,
    components,
    wrappedDataKey: wrapDataKey(dataKey, credential),
  }

  await fs.promises.writeFile(
    /*turbopackIgnore: true*/ path.join(bundleDir, MANIFEST_FILE),
    JSON.stringify(manifest, null, 2),
  )

  return { bundleDir, manifest, credential }
}

// ─── Component collection ────────────────────────────────────────────────────

export interface DeploymentMetadata {
  backenlyVersion: string
  schemaVersion: string
  postgresVersion: string
  requiredExtensions: string[]
  edition: string
  /**
   * Exactly which schemas this bundle will create on restore.
   *
   * Recorded rather than derived, because the restorer has to drop them before
   * replaying - pg_dump emits CREATE SCHEMA, which collides with anything
   * already there. The alternative is parsing CREATE SCHEMA out of the dump,
   * and a restore that decides what to drop by pattern-matching SQL is a
   * restore that will one day drop the wrong thing.
   */
  schemas: string[]
}

async function collectDeploymentMetadata(): Promise<DeploymentMetadata> {
  const [{ server_version }] = await prisma.$queryRawUnsafe<{ server_version: string }[]>(
    'SHOW server_version',
  )
  const extensions = await prisma.$queryRawUnsafe<{ extname: string }[]>(
    'SELECT extname FROM pg_extension ORDER BY extname',
  )
  // The latest APPLIED migration, not the latest on disk: a bundle describes the
  // database it was taken from, not the checkout that took it.
  //
  // Asked for existence first rather than catching the failure. A deployment
  // built with `db push` has no _prisma_migrations, which is a normal state -
  // but querying it anyway makes Prisma log a red `prisma:error` line, and an
  // operator watching their first backup scroll past that reasonably concludes
  // it broke.
  const [{ present }] = await prisma.$queryRawUnsafe<{ present: boolean }[]>(
    `SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present`,
  )
  const migrations = present
    ? await prisma.$queryRawUnsafe<{ migration_name: string }[]>(
        `SELECT migration_name FROM _prisma_migrations
         WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`,
      )
    : []

  let backenlyVersion = 'unknown'
  try {
    const pkg = JSON.parse(
      await fs.promises.readFile(
        /*turbopackIgnore: true*/ path.join(process.cwd(), 'package.json'),
        'utf8',
      ),
    )
    backenlyVersion = String(pkg.version ?? 'unknown')
  } catch {
    // A bundle with an unknown version is still restorable; refusing to export
    // because package.json moved would be the wrong trade.
  }

  return {
    backenlyVersion,
    schemaVersion: migrations[0]?.migration_name ?? 'unknown',
    postgresVersion: server_version,
    requiredExtensions: extensions.map(e => e.extname),
    edition: process.env.BACKENLY_EDITION ?? 'single-tenant',
    schemas: ['public', ...(await workspaceSchemaNames())],
  }
}

/** Every workspace schema in the source deployment, in a stable order. */
export async function workspaceSchemaNames(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ nspname: string }[]>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace\_%' ORDER BY nspname`,
  )
  return rows.map(r => r.nspname)
}

async function collectPlatformDatabase(): Promise<CollectedComponent[]> {
  const sql = await runPgDump(platformDumpArgs())
  return [{ component: 'platform-database', content: sql, items: 1 }]
}

async function collectWorkspaceSchemas(): Promise<CollectedComponent[]> {
  const rows = await prisma.$queryRawUnsafe<{ nspname: string }[]>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace\\_%' ORDER BY nspname`,
  )
  const schemas = rows.map(r => r.nspname)
  if (schemas.length === 0) {
    // Present and empty, not absent: a deployment with no projects is a real
    // state, and the manifest has to be able to say so. See ComponentEntry.
    return [{ component: 'workspace-schemas', content: Buffer.alloc(0), items: 0 }]
  }
  const sql = await runPgDump(workspaceDumpArgs(schemas))
  return [{ component: 'workspace-schemas', content: sql, items: schemas.length }]
}

async function collectFunctionDefinitions(): Promise<CollectedComponent[]> {
  // Carried separately even though these rows are inside the platform dump.
  // A bundle whose only copy of user-authored code is embedded in a Postgres
  // dump is a bundle where that code cannot be read back without a working
  // Postgres, on the day there may not be one.
  const functions = await prisma.aiFunction.findMany({
    orderBy: [{ projectId: 'asc' }, { name: 'asc' }],
  })
  return [{
    component: 'function-definitions',
    content: asJson(functions),
    items: functions.length,
  }]
}

async function collectProjectSecrets(): Promise<CollectedComponent[]> {
  const projects = await prisma.project.findMany({
    select: { id: true, name: true, jwtSecret: true, anonKey: true },
    orderBy: { id: 'asc' },
  })
  return [{ component: 'project-secrets', content: asJson(projects), items: projects.length }]
}

async function collectOperatorOwnership(): Promise<CollectedComponent[]> {
  // Who the deployment belongs to. Without it a restore produces a running
  // installation nobody can administer, which is not a recovered deployment.
  const users = await prisma.user.findMany({
    select: { id: true, email: true, name: true, role: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
  const projects = await prisma.project.findMany({
    select: { id: true, name: true, userId: true },
    orderBy: { id: 'asc' },
  })
  return [{
    component: 'operator-ownership',
    content: asJson({ users, projects }),
    items: users.length,
  }]
}

async function collectStorageObjects(storageDir?: string): Promise<CollectedComponent[]> {
  const dir = storageDir ?? process.env.STORAGE_DIR ?? path.join(process.cwd(), 'storage')
  const exists = await fs.promises.stat(/*turbopackIgnore: true*/ dir).then(
    s => s.isDirectory(),
    () => false,
  )
  if (!exists) {
    return [{ component: 'storage-objects', content: Buffer.alloc(0), items: 0 }]
  }

  const files = await countFiles(dir)
  const tar = await tarDirectory(dir)
  return [{ component: 'storage-objects', content: tar, items: files }]
}

// ─── Plumbing ────────────────────────────────────────────────────────────────

function asJson(value: unknown): Buffer {
  // Stable key order and a trailing newline, so two exports of an unchanged
  // deployment produce identical bytes and identical checksums.
  return Buffer.from(JSON.stringify(value, jsonSafe, 2) + '\n', 'utf8')
}

/** Prisma returns BigInt and Date, neither of which JSON.stringify handles. */
function jsonSafe(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  return value
}

async function runPgDump(args: string[]): Promise<Buffer> {
  const conn = buildConnection('read')
  try {
    // execFile, not exec: no shell, and nothing for an error message to quote
    // back containing the credential. maxBuffer is generous because a platform
    // dump is the whole control plane.
    const { stdout } = await execFileAsync('pg_dump', [...conn.args, ...args], {
      env: conn.env,
      timeout: 600_000,
      maxBuffer: 1024 * 1024 * 512,
      encoding: 'buffer',
    })
    return stdout as unknown as Buffer
  } catch (err) {
    const message = sanitizeError((err as { message?: string })?.message ?? String(err))
    throw new Error(`pg_dump failed while writing the recovery bundle: ${message}`)
  }
}

async function countFiles(dir: string): Promise<number> {
  let count = 0
  const entries = await fs.promises.readdir(
    /*turbopackIgnore: true*/ dir,
    { withFileTypes: true },
  )
  for (const entry of entries) {
    if (entry.isDirectory()) count += await countFiles(path.join(dir, entry.name))
    else count += 1
  }
  return count
}

function tarDirectory(dir: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const archive = archiver('tar', {})
    archive.on('data', (chunk: Buffer) => chunks.push(chunk))
    archive.on('error', reject)
    archive.on('end', () => resolve(Buffer.concat(chunks)))
    archive.directory(dir, false)
    archive.finalize().catch(reject)
  })
}

/** Every component the writer knows how to produce. Used by tests and the CLI. */
export function exportableComponents(): readonly RecoveryComponent[] {
  return RECOVERY_COMPONENTS
}
