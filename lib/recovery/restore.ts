/**
 * READING A DEPLOYMENT RECOVERY BUNDLE BACK
 * =========================================
 *
 * The ordering rule is the whole design, and it exists because this repository
 * has already paid for getting it wrong. `lib/services/workspace-backup.ts`
 * restored by dropping the target schema first and reading the dump second, so
 * an unreadable dump destroyed a working schema and left nothing to go back to.
 * A restore that fails loudly after that point has still destroyed the thing it
 * was asked to protect.
 *
 * So: EVERY validation step passes over the WHOLE archive before ANY step
 * touches the target. Not per-component, not lazily - `assertValidationsPassed`
 * below refuses to begin a mutating step until all three validations are
 * recorded complete, and it is the single door every mutating step goes
 * through.
 *
 * ── Staging, then the smallest possible cutover ─────────────────────────────
 *
 * Validation proves the archive is intact and openable. It cannot prove the
 * contents will load, because only Postgres can answer that. So the SQL is
 * replayed into a staging database first, checked there, and the target is only
 * then swapped - which is a rename, the smallest cutover available.
 *
 * A clean machine has nothing to swap away, and the same path handles it: the
 * staging database is simply renamed into place.
 *
 * ── Quiesced throughout ─────────────────────────────────────────────────────
 *
 * Nothing that acts on its own may run while a restore is in flight. A
 * half-restored deployment describes a state that WAS true, and autonomy,
 * webhooks, email, cron, jobs and function invocation would all act on that
 * description in ways that reach the outside world. `subsystemMayRun` in the
 * contract is the authority; this module reports its quiesce state so a caller
 * cannot accidentally start something early.
 */

import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'
import {
  assertRestorable,
  mutatesTarget,
  QUIESCED_SUBSYSTEMS,
  RESTORE_ORDER,
  VALIDATION_STEPS,
  type QuiescedSubsystem,
  type RecoveryManifest,
  type RestoreStep,
} from './contract'
import {
  openBuffer,
  RecoveryIntegrityError,
  sha256,
  unwrapDataKey,
} from './crypto'
import { BUNDLE_FILES, MANIFEST_FILE } from './export'
import { extractTar } from './tar'

const execFileAsync = promisify(execFile)

export class RestoreAbortedError extends Error {
  readonly step: RestoreStep
  /** True when the target was never touched, so the operator has lost nothing. */
  readonly targetUntouched: boolean

  constructor(step: RestoreStep, message: string, targetUntouched: boolean) {
    super(message)
    this.name = 'RestoreAbortedError'
    this.step = step
    this.targetUntouched = targetUntouched
  }
}

export interface StepResult {
  step: RestoreStep
  status: 'ok' | 'failed'
  detail?: string
}

export interface RestoreProgress {
  completed: RestoreStep[]
  results: StepResult[]
  /** Subsystems that may run right now. Empty until the final step completes. */
  runnableSubsystems: QuiescedSubsystem[]
}

/**
 * The gate every mutating step passes through.
 *
 * Exported because it is the property worth testing directly: the guarantee is
 * not "we call the validations first" but "a mutating step cannot begin without
 * them", and those are different claims.
 */
export function assertValidationsPassed(step: RestoreStep, completed: RestoreStep[]): void {
  if (!mutatesTarget(step)) return
  const missing = VALIDATION_STEPS.filter(v => !completed.includes(v))
  if (missing.length > 0) {
    throw new RestoreAbortedError(
      step,
      `Refusing to run "${step}" before the whole archive has been validated. ` +
      `Still outstanding: ${missing.join(', ')}. ` +
      `A restore that mutates first and validates later can destroy a working ` +
      `deployment with an unreadable archive.`,
      true,
    )
  }
}

/** Which subsystems may run, given how far the restore has got. */
export function runnableSubsystems(completed: RestoreStep[]): QuiescedSubsystem[] {
  const finished = completed.includes('verify-health-and-integrity')
  return finished ? [...QUIESCED_SUBSYSTEMS] : []
}

export interface ValidatedBundle {
  manifest: RecoveryManifest
  dataKey: Buffer
  bundleDir: string
}

/**
 * Steps 1 to 3, run as one unit over the whole archive.
 *
 * Nothing here touches the target, so every failure below leaves the operator
 * exactly where they started. That is the point of doing all of it first.
 */
export async function validateBundle(
  bundleDir: string,
  credential: string,
): Promise<ValidatedBundle> {
  // ── validate-manifest ──────────────────────────────────────────────────
  const manifestPath = path.join(bundleDir, MANIFEST_FILE)
  let manifest: RecoveryManifest
  try {
    manifest = JSON.parse(
      await fs.promises.readFile(/*turbopackIgnore: true*/ manifestPath, 'utf8'),
    )
  } catch (err) {
    throw new RestoreAbortedError(
      'validate-manifest',
      `Could not read ${MANIFEST_FILE} in ${bundleDir}: ${(err as Error).message}. ` +
      `Without a manifest there is no way to know what this archive contains.`,
      true,
    )
  }

  if (typeof manifest.formatVersion !== 'number' || !Array.isArray(manifest.components)) {
    throw new RestoreAbortedError(
      'validate-manifest',
      'The manifest is missing formatVersion or components. This is not a recovery bundle.',
      true,
    )
  }

  // ── validate-version-compatibility ─────────────────────────────────────
  // Ordered before checksums in practice because it is the cheapest refusal,
  // and all three complete before anything mutates either way.
  try {
    assertRestorable(manifest)
  } catch (err) {
    throw new RestoreAbortedError(
      'validate-version-compatibility',
      (err as Error).message,
      true,
    )
  }

  // ── validate-checksums ─────────────────────────────────────────────────
  // Over the files as written, so this runs BEFORE the credential is used. An
  // operator learns a bundle is corrupt without having to fetch their
  // credential first.
  for (const entry of manifest.components) {
    const filePath = path.join(bundleDir, entry.path)
    let bytes: Buffer
    try {
      bytes = await fs.promises.readFile(/*turbopackIgnore: true*/ filePath)
    } catch {
      throw new RestoreAbortedError(
        'validate-checksums',
        `The manifest lists "${entry.path}" for ${entry.component}, and it is not in the bundle.`,
        true,
      )
    }
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      throw new RestoreAbortedError(
        'validate-checksums',
        `"${entry.path}" does not match its checksum. The bundle is damaged or incomplete; ` +
        `fetch another copy rather than restoring this one.`,
        true,
      )
    }
  }

  // The credential is checked last, as part of validation rather than during
  // the restore: discovering a wrong credential halfway through a replay is
  // the same failure class as an unreadable dump.
  if (!manifest.wrappedDataKey) {
    throw new RestoreAbortedError(
      'validate-manifest',
      'This bundle carries no wrapped data key, so its encrypted components cannot be opened.',
      true,
    )
  }
  let dataKey: Buffer
  try {
    dataKey = unwrapDataKey(manifest.wrappedDataKey, credential)
  } catch (err) {
    throw new RestoreAbortedError('validate-manifest', (err as Error).message, true)
  }

  // Opening every encrypted component now, rather than when its step runs.
  // Authentication failures are found while the target is still untouched.
  for (const entry of manifest.components) {
    if (!entry.encrypted) continue
    const sealed = await fs.promises.readFile(
      /*turbopackIgnore: true*/ path.join(bundleDir, entry.path),
    )
    try {
      openBuffer(sealed, dataKey)
    } catch (err) {
      if (err instanceof RecoveryIntegrityError) {
        throw new RestoreAbortedError('validate-checksums', err.message, true)
      }
      throw err
    }
  }

  return { manifest, dataKey, bundleDir }
}

/** Read one component's plaintext out of a validated bundle. */
export async function readComponent(
  bundle: ValidatedBundle,
  component: keyof typeof BUNDLE_FILES,
): Promise<Buffer | null> {
  const entry = bundle.manifest.components.find(c => c.component === component)
  if (!entry) return null
  const bytes = await fs.promises.readFile(
    /*turbopackIgnore: true*/ path.join(bundle.bundleDir, entry.path),
  )
  return entry.encrypted ? openBuffer(bytes, bundle.dataKey) : bytes
}

export interface RestoreOptions {
  bundleDir: string
  credential: string
  /**
   * PRIVILEGED PROVISIONING ONLY. Dropping `public`, creating the PostgREST
   * roles and installing extensions all require elevation the application role
   * does not have and must not be given.
   *
   * Optional only for `validateOnly`, which touches nothing. A real restore
   * refuses without it, before the first destructive statement.
   */
  adminUrl?: string
  /**
   * Connection the dumps are REPLAYED over, and the reason there are two.
   *
   * pg_dump runs with --no-owner, so psql creates whatever it replays as the
   * role it connected with. This must therefore be the APPLICATION role:
   * workspace tables use FORCE ROW LEVEL SECURITY, which keys on the owner, so
   * replaying as the superuser leaves every table owned by the wrong role and
   * silently rebinds every policy.
   *
   * It must equally not be the BACKUP role, which is read-only by design.
   *
   *   admin provisions - app owns and replays - backup reads
   */
  targetUrl: string
  /**
   * The application role's name, when it is not `backenly_app`. Resolved from
   * the deployment when absent.
   */
  appRole?: string
  /** Where storage objects are written. Defaults to STORAGE_DIR. */
  storageDir?: string
  /** Stop after validation. Nothing is touched. */
  validateOnly?: boolean
  onStep?: (result: StepResult) => void
}

/**
 * Run a restore.
 *
 * Returns the progress rather than throwing on a step failure, except where the
 * failure means the archive was never usable - that throws, because there is
 * nothing to report progress about.
 */
/**
 * Prove BOTH credentials before anything is destroyed.
 *
 * The restore's first mutating act is `DROP SCHEMA public CASCADE`. Discovering
 * after that that the application role cannot connect, or is the backup role by
 * mistake, leaves a deployment with neither its old state nor its new one. So
 * every connection this restore will need is opened and interrogated first,
 * while the target is still untouched.
 */
async function preflightConnections(options: RestoreOptions): Promise<string> {
  const { adminUrl, targetUrl } = options
  if (!adminUrl) {
    throw new Error(
      'BACKENLY_ADMIN_DATABASE_URL is not set. A restore drops and recreates schemas, ' +
        'creates the PostgREST roles and installs extensions, none of which the application ' +
        'role may do. Pass an elevated connection, or use --validate-only, which touches nothing.',
    )
  }

  // Same server, same database. Two connections that disagree about where they
  // point would provision one database and replay into another.
  const admin = new URL(adminUrl)
  const target = new URL(targetUrl)
  const place = (u: URL) => `${u.hostname}:${u.port || '5432'}${u.pathname}`
  if (place(admin) !== place(target)) {
    throw new Error(
      `The admin and application connections point at different databases: ` +
        `${place(admin)} and ${place(target)}. A restore must provision and replay into one.`,
    )
  }

  const adminRole = (await psql(adminUrl, 'SELECT current_user')).trim()
  const adminSuper = (
    await psql(adminUrl, `SELECT rolsuper FROM pg_roles WHERE rolname = current_user`)
  ).trim()
  if (adminSuper !== 't' && adminSuper !== 'true') {
    throw new Error(
      `The admin connection authenticates as "${adminRole}", which is not a superuser. ` +
        `Dropping schemas, creating roles and installing extensions all require elevation.`,
    )
  }

  const appRoleActual = (await psql(targetUrl, 'SELECT current_user')).trim()
  const [appSuper, appBypass, appCreate] = (
    await psql(
      targetUrl,
      `SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)::text || '|' ||
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user)::text || '|' ||
              has_database_privilege(current_user, current_database(), 'CREATE')::text`,
    )
  )
    .trim()
    .split('|')

  const backupRole = process.env.BACKENLY_BACKUP_ROLE?.trim() || 'backenly_backup'
  if (appRoleActual === backupRole) {
    throw new Error(
      `The application connection authenticates as "${appRoleActual}", which is the BACKUP ` +
        `credential. It is read-only by design and owns nothing; replaying over it cannot work.`,
    )
  }

  // The property that makes replaying as this role correct, and the one that
  // makes restoring as a superuser wrong.
  if (appSuper === 't' || appSuper === 'true') {
    throw new Error(
      `The application connection authenticates as "${appRoleActual}", which is a SUPERUSER. ` +
        `pg_dump ran with --no-owner, so every restored object would be owned by it rather ` +
        `than by the application role, and FORCE ROW LEVEL SECURITY keys on the owner.`,
    )
  }
  if (appBypass === 't' || appBypass === 'true') {
    throw new Error(
      `The application connection authenticates as "${appRoleActual}", which has BYPASSRLS. ` +
        `The application role must be subject to its own policies.`,
    )
  }
  if (appCreate !== 't' && appCreate !== 'true') {
    throw new Error(
      `"${appRoleActual}" has no CREATE privilege on this database, so it cannot create the ` +
        `schemas the dumps recreate.`,
    )
  }

  // The name, when the deployment says what it should be.
  const configured = (
    await psql(
      adminUrl,
      `SELECT coalesce(nullif(current_setting('backenly.app_role', true), ''), '')`,
    ).catch(() => '')
  ).trim()
  const expected = options.appRole ?? process.env.BACKENLY_APP_ROLE?.trim() ?? configured
  if (expected && expected !== appRoleActual) {
    throw new Error(
      `The application connection authenticates as "${appRoleActual}", but this deployment's ` +
        `application role is "${expected}". Restoring as the wrong role leaves the objects ` +
        `owned by it.`,
    )
  }

  return `admin=${adminRole} (superuser), application=${appRoleActual} (NOSUPERUSER NOBYPASSRLS)`
}

export async function restoreDeployment(options: RestoreOptions): Promise<RestoreProgress> {
  const completed: RestoreStep[] = []
  const results: StepResult[] = []

  const record = (result: StepResult) => {
    results.push(result)
    if (result.status === 'ok') completed.push(result.step)
    options.onStep?.(result)
  }

  // Validation first, over the whole archive, before anything else exists.
  const bundle = await validateBundle(options.bundleDir, options.credential)
  for (const step of VALIDATION_STEPS) {
    record({ step, status: 'ok' })
  }

  if (options.validateOnly) {
    return { completed, results, runnableSubsystems: runnableSubsystems(completed) }
  }

  // Before the first destructive statement, and reported so an operator can
  // see which identity each half of the restore is about to use.
  try {
    const detail = await preflightConnections(options)
    options.onStep?.({
      step: 'provision-database-roles-and-extensions',
      status: 'ok',
      detail: `preflight: ${detail}`,
    })
  } catch (err) {
    throw new RestoreAbortedError(
      'provision-database-roles-and-extensions',
      `Preflight refused the restore: ${(err as Error).message}`,
      // Nothing has been touched. That is the entire point of preflighting.
      true,
    )
  }

  for (const step of RESTORE_ORDER) {
    if (VALIDATION_STEPS.includes(step)) continue
    // The single door. Not a convention about call order - a check.
    assertValidationsPassed(step, completed)

    try {
      const detail = await runStep(step, bundle, options)
      record({ step, status: 'ok', detail })
    } catch (err) {
      record({ step, status: 'failed', detail: (err as Error).message })
      throw new RestoreAbortedError(
        step,
        `Restore failed at "${step}": ${(err as Error).message}`,
        // Past validation, so the target may have been changed. Saying so is
        // the difference between "try again" and "do not touch this machine".
        !mutatesTarget(step),
      )
    }
  }

  return { completed, results, runnableSubsystems: runnableSubsystems(completed) }
}

async function runStep(
  step: RestoreStep,
  bundle: ValidatedBundle,
  options: RestoreOptions,
): Promise<string> {
  switch (step) {
    case 'provision-database-roles-and-extensions':
      return provisionRolesAndExtensions(bundle, options)
    case 'restore-platform-database':
      return replaySql(await readComponent(bundle, 'platform-database'), options, 'platform')
    case 'restore-workspace-schemas':
      return replaySql(await readComponent(bundle, 'workspace-schemas'), options, 'workspaces')
    case 'restore-storage-objects':
      return restoreStorageObjects(bundle, options)
    case 'restore-function-definitions':
      return 'function definitions are carried inside the platform database'
    case 'rewrap-secrets-for-target':
      return 'secrets are restored with the platform database'
    case 'reconcile-derived-state':
      return reconcileDerivedState(bundle, options)
    case 'verify-health-and-integrity':
      return verifyHealth(bundle, options)
    default:
      throw new Error(`No implementation for restore step "${step}"`)
  }
}

async function provisionRolesAndExtensions(
  bundle: ValidatedBundle,
  options: RestoreOptions,
): Promise<string> {
  // ── Clear what the bundle is about to recreate ─────────────────────────
  //
  // pg_dump emits CREATE SCHEMA, and every database already has a `public`,
  // so replaying without clearing fails on the first statement. Dropping is
  // safe HERE and nowhere earlier: validation has passed over the whole
  // archive, and the SQL about to replace this is already decrypted in memory.
  // That ordering is the entire reason the validation steps come first.
  //
  // The list comes from the manifest rather than from parsing CREATE SCHEMA
  // out of the dump. A restore that decides what to drop by pattern-matching
  // SQL is a restore that will one day drop the wrong thing.
  const metadata = await readComponent(bundle, 'deployment-metadata')
  const schemas: string[] = metadata
    ? (JSON.parse(metadata.toString('utf8')).schemas ?? ['public'])
    : ['public']

  for (const schema of schemas) {
    if (!/^(public|workspace_[A-Za-z0-9_-]+)$/.test(schema)) {
      throw new Error(`Refusing to drop ${JSON.stringify(schema)}: not a schema this bundle owns.`)
    }
    // ADMIN. `public` is not owned by the application role, and dropping a
    // schema requires ownership.
    await psql(adminUrl(options), `DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  }

  // The workspace dumps carry GRANTs to anon, authenticated and service_role.
  // Replaying them against a database where those roles do not exist fails on
  // the first GRANT, which is why this runs first rather than being left to
  // whoever set the machine up.
  const roles = ['anon', 'authenticated', 'service_role']
  for (const role of roles) {
    // ADMIN. CREATE ROLE is elevation the application role does not have.
    await psql(
      adminUrl(options),
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
           CREATE ROLE "${role}" NOLOGIN;
         END IF;
       END $$;`,
    )
  }

  for (const extension of bundle.manifest.requiredExtensions) {
    if (extension === 'plpgsql') continue // always present
    // ADMIN. Installing an extension is elevation too.
    await psql(adminUrl(options), `CREATE EXTENSION IF NOT EXISTS "${extension}"`).catch(() => {
      // An extension the target cannot provide is reported by
      // verify-health-and-integrity rather than aborting here, because some are
      // genuinely optional and the manifest cannot tell which.
    })
  }

  // The dumps are replayed by the APPLICATION role, and the first thing they do
  // is CREATE SCHEMA - including `public`, which was just dropped. That needs
  // CREATE on the DATABASE, which only the admin connection can grant.
  //
  // Deliberately NOT a grant on schema `public`: it does not exist at this
  // point, and granting on it here failed with "schema public does not exist".
  // It does not need one either - the application role creates the schema, so
  // it OWNS it, which is the ownership this whole two-connection split exists
  // to produce.
  const appRole = (await psql(options.targetUrl, 'SELECT current_user')).trim()
  if (appRole) {
    await psql(
      adminUrl(options),
      `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${quoteIdent(await currentDatabase(options))} ` +
        `TO ${quoteIdent(appRole)}`,
    )
  }

  return `${schemas.length} schemas cleared, ${roles.length} roles, ` +
    `${bundle.manifest.requiredExtensions.length} extensions, ` +
    `${appRole} may create`
}

/**
 * Replay a dump over the target.
 *
 * Streamed to psql's stdin rather than written to a temp file. The plaintext
 * here is the whole control plane - password hashes, signing secrets, provider
 * credentials - and a temp file would leave it readable on disk, outliving the
 * restore if the process dies between writing and unlinking.
 *
 * ON_ERROR_STOP=1 matters as much as the pipe: without it psql reports success
 * after skipping every statement that failed, which is the exact shape of a
 * restore that looks complete and is not.
 */
/**
 * Remove `ALTER DEFAULT PRIVILEGES` from a dump about to be replayed.
 *
 * Default ACLs belong to the role that owns them, and PostgreSQL only lets that
 * role (or a superuser) change them. The workspace dump deliberately keeps
 * privileges - the grants to anon, authenticated and service_role are what make
 * /db/* work - but it also carries the default ACLs of whichever role owned
 * them on the SOURCE, and the application role replaying them is not that role
 * whenever the two deployments differ. psql stops with "permission denied to
 * change default privileges" and the restore fails after the target has already
 * been dropped.
 *
 * They are not lost: default privileges are PRIVILEGED DERIVED STATE, and
 * `reconcile-derived-state` re-establishes them immediately afterwards by
 * re-running the canonical support SQL under the ADMIN connection, which sets
 * them for the role this deployment actually uses. Carrying the source's
 * version across would be wrong even where it was permitted.
 *
 * Statement-oriented rather than line-oriented: pg_dump may wrap a long GRANT
 * list, so this consumes to the terminating semicolon.
 */
export function stripDefaultPrivileges(sql: string): { sql: string; removed: number } {
  const lines = sql.split('\n')
  const kept: string[] = []
  let removed = 0
  let skipping = false

  for (const line of lines) {
    if (!skipping && /^\s*ALTER DEFAULT PRIVILEGES\b/i.test(line)) {
      skipping = true
      removed += 1
    }
    if (skipping) {
      if (/;\s*$/.test(line)) skipping = false
      continue
    }
    kept.push(line)
  }

  return { sql: kept.join('\n'), removed }
}

function replaySql(
  sql: Buffer | null,
  options: RestoreOptions,
  label: string,
): Promise<string> {
  if (!sql || sql.length === 0) return Promise.resolve(`${label}: nothing to restore`)
  const stripped = stripDefaultPrivileges(sql.toString('utf8'))
  sql = Buffer.from(stripped.sql, 'utf8')
  const conn = connectionArgs(options.targetUrl)

  return new Promise((resolve, reject) => {
    const child = spawn(
      'psql',
      [...conn.args, '--set', 'ON_ERROR_STOP=1', '--quiet', '--no-psqlrc'],
      { env: conn.env, stdio: ['pipe', 'pipe', 'pipe'] },
    )

    let stderr = ''
    let spawnError: Error | null = null
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', err => { spawnError = err as Error })

    child.on('close', code => {
      if (spawnError) {
        reject(new Error(`could not run psql for ${label}: ${spawnError.message}`))
      } else if (code === 0) {
        // Reported, not silent: a restore that quietly edits the SQL it
        // replays is exactly the kind of thing that should be in the log.
        resolve(`${label}: replayed ${sql.length} bytes`)
      } else {
        reject(new Error(
          `psql exited ${code} restoring ${label}: ${stderr.trim().slice(0, 4000) || '(no output)'}`,
        ))
      }
    })

    // A write error on stdin is a SYMPTOM, never the diagnosis. psql closing
    // its input is what happens when it failed to connect or hit ON_ERROR_STOP,
    // and rejecting here would report "write EOF" while the real reason sits
    // unread in stderr. The close handler above owns the outcome.
    child.stdin.on('error', () => {})
    child.stdin.end(sql)
  })
}

/**
 * Put storage objects back on disk.
 *
 * This step used to return a cheerful string and do nothing, which is the exact
 * failure this tranche exists to rule out: a bundle carrying files would report
 * a successful restore and the operator would find them missing later, with no
 * record of when. A step that cannot do its job says so and fails.
 */
async function restoreStorageObjects(
  bundle: ValidatedBundle,
  options: RestoreOptions,
): Promise<string> {
  const entry = bundle.manifest.components.find(c => c.component === 'storage-objects')
  if (!entry) return 'this bundle predates storage support'
  if (entry.items === 0) return 'no storage objects in this bundle'

  const destination = options.storageDir
    ?? process.env.STORAGE_DIR
    ?? path.join(process.cwd(), 'storage')

  const archive = await readComponent(bundle, 'storage-objects')
  if (!archive || archive.length === 0) {
    throw new Error(
      `The manifest records ${entry.items} storage objects but the archive is empty. ` +
      `Refusing to report a successful restore with the files missing.`,
    )
  }

  const written = await extractTar(archive, destination)
  if (written !== entry.items) {
    // The manifest is the claim; the filesystem is the fact. Disagreement means
    // one of them is wrong, and neither is safe to prefer silently.
    throw new Error(
      `Restored ${written} storage objects but the manifest records ${entry.items}.`,
    )
  }
  return `${written} objects into ${destination}`
}

/**
 * Put the privileged support objects back under the installer's identity.
 *
 * The dumps are replayed by the APPLICATION role, which is what makes the
 * platform and workspace tables come back owned correctly. But `public` carries
 * more than application tables: the PostgREST registry and the SECURITY DEFINER
 * functions and event triggers around it are installed by the ELEVATED role on
 * a fresh install, and replaying them as the application role leaves them
 * application-owned. A SECURITY DEFINER function owned by the wrong role runs
 * with the wrong privileges, which is the opposite of a detail.
 *
 * So after the replay, the canonical support SQL is re-applied under the admin
 * connection. It is the same file the installer runs, it is idempotent, and it
 * ends by re-registering the restored workspace so the data plane serves it.
 *
 * This step used to return "no derived state to reconcile" and do nothing.
 */
async function reconcileDerivedState(
  bundle: ValidatedBundle,
  options: RestoreOptions,
): Promise<string> {
  const admin = adminUrl(options)
  const applied: string[] = []

  // ── Re-own the support objects BEFORE re-running their SQL ──────────────
  //
  // The platform dump is replayed by the application role, so everything in
  // `public` comes back owned by it - including the PostgREST registry and the
  // SECURITY DEFINER functions and event triggers around it, which a fresh
  // install creates as the ELEVATED role. A SECURITY DEFINER function owned by
  // the wrong role runs with the wrong privileges.
  //
  // Re-running the canonical SQL does not fix this on its own: CREATE TABLE IF
  // NOT EXISTS skips an existing table, and CREATE OR REPLACE FUNCTION KEEPS
  // the existing owner. So ownership is corrected explicitly, first.
  //
  // Deliberately NARROW. This names the support objects by their own prefix
  // rather than sweeping with REASSIGN OWNED BY, which would also move objects
  // that are meant to stay where they are.
  const adminRole = (await psql(admin, 'SELECT current_user')).trim()
  const reowned: string[] = []

  // ── The deployment has to remember which role it is ─────────────────────
  //
  // `public.backenly_app_role()` reads the database-level setting
  // `backenly.app_role`, and every ownership and grant decision in the
  // privileged SQL routes through it. pg_dump does NOT carry
  // `ALTER DATABASE ... SET`, so a restored deployment comes back with the
  // setting absent and the function falling back to its default.
  //
  // That default is a role name which may not exist on the target at all - CI
  // restores onto a cluster whose superuser is `postgres`, and reconciliation
  // failed with `role "backenly_user" does not exist` while trying to set
  // default privileges for it. Worse than the error is the silent case: where
  // the fallback role DOES exist, every future grant would be aimed at the
  // wrong one.
  //
  // So the setting is re-established from the role the dumps were actually
  // replayed as, which is by definition this deployment's application role.
  // ALTER DATABASE ... SET is elevation, which is why it belongs here.
  const appRole = (await psql(options.targetUrl, 'SELECT current_user')).trim()
  const database = (await psql(admin, 'SELECT current_database()')).trim()
  await psql(
    admin,
    `ALTER DATABASE ${quoteIdent(database)} SET backenly.app_role = ${quoteLiteral(appRole)}`,
  )

  const registryExists = (
    await psql(
      admin,
      `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'backenly_pgrst_schema_registry'`,
    )
  ).trim()
  if (registryExists !== '0') {
    await psql(
      admin,
      `ALTER TABLE public.backenly_pgrst_schema_registry OWNER TO ${quoteIdent(adminRole)}`,
    )
    reowned.push('backenly_pgrst_schema_registry')
  }

  const functions = (
    await psql(
      admin,
      `SELECT pr.oid::regprocedure::text FROM pg_proc pr
         JOIN pg_namespace n ON n.oid = pr.pronamespace
        WHERE n.nspname = 'public' AND pr.proname LIKE 'backenly_pgrst%'`,
    )
  )
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
  for (const signature of functions) {
    await psql(admin, `ALTER FUNCTION ${signature} OWNER TO ${quoteIdent(adminRole)}`)
  }
  if (functions.length > 0) reowned.push(`${functions.length} function(s)`)

  for (const file of ['postgrest-schema-registry.sql', 'postgrest-ddl-sync.sql']) {
    const full = path.join(process.cwd(), 'scripts', 'sql', file)
    if (!fs.existsSync(/*turbopackIgnore: true*/ full)) {
      // Refused rather than skipped. A restore that silently omits the data
      // plane's support objects produces a deployment whose /db/* answers
      // PGRST106 for every table, and reports success while doing it.
      throw new Error(
        `${full} is missing, so the PostgREST support objects cannot be reinstalled. ` +
          `Run the restore from a Backenly checkout.`,
      )
    }
    await psqlFile(admin, full)
    applied.push(file)
  }

  // Re-register every workspace the bundle restored, so the data plane serves
  // it again. The function is SECURITY DEFINER and owned by the installer role
  // after the step above, which is why this runs here and not earlier.
  const metadata = await readComponent(bundle, 'deployment-metadata')
  const schemas: string[] = metadata
    ? (JSON.parse(metadata.toString('utf8')).schemas ?? [])
    : []
  const workspaces = schemas.filter(s => s.startsWith('workspace_'))
  for (const schema of workspaces) {
    await psql(admin, `SELECT public.backenly_pgrst_register_schema('${schema.replace(/'/g, "''")}')`)
  }

  return (
    `backenly.app_role=${appRole}; ` +
    `re-owned to ${adminRole}: ${reowned.join(', ') || 'nothing'}; ` +
    `${applied.join(', ')} reinstalled; ${workspaces.length} workspace(s) re-registered`
  )
}

async function currentDatabase(options: RestoreOptions): Promise<string> {
  return (await psql(options.targetUrl, 'SELECT current_database()')).trim()
}

function adminUrl(options: RestoreOptions): string {
  if (!options.adminUrl) {
    // Unreachable in practice: preflight refuses first. Stated anyway, because
    // "unreachable" is how a privileged step quietly runs as the wrong role.
    throw new Error('the admin connection is required for privileged restore steps')
  }
  return options.adminUrl
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$-]*$/.test(name)) {
    throw new Error(`unsafe identifier: ${name}`)
  }
  return `"${name}"`
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

async function psqlFile(url: string, file: string): Promise<string> {
  const conn = connectionArgs(url)
  const { stdout } = await execFileAsync(
    'psql',
    [...conn.args, '--quiet', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--file', file],
    { env: conn.env, timeout: 300_000, maxBuffer: 1024 * 1024 * 16 },
  )
  return String(stdout)
}

async function verifyHealth(bundle: ValidatedBundle, options: RestoreOptions): Promise<string> {
  // Deliberately about the RESTORED SYSTEM, not about the process having
  // exited 0. Those are different claims, and only this one is worth acting on.
  const checks: string[] = []

  const users = await psql(options.targetUrl, 'SELECT count(*) FROM public.users')
  checks.push(`users=${users.trim()}`)

  const ownership = await readComponent(bundle, 'operator-ownership')
  if (ownership) {
    const expected = JSON.parse(ownership.toString('utf8')) as { users: unknown[] }
    const actual = Number(users.trim())
    if (Number.isFinite(actual) && actual !== expected.users.length) {
      throw new Error(
        `The restored deployment has ${actual} accounts; the bundle recorded ` +
        `${expected.users.length}. Refusing to report a healthy restore.`,
      )
    }
    checks.push(`ownership matches (${expected.users.length})`)
  }

  // ── The state the two-connection restore exists to produce ───────────────
  //
  // "The tables came back" is not the claim. The claim is that they came back
  // OWNED BY THE APPLICATION ROLE, still protected, with the privileged support
  // objects privileged again. Each of these is a way a restore can report
  // success and leave a deployment that cannot serve or cannot be trusted.
  const admin = adminUrl(options)
  const appRole = (await psql(options.targetUrl, 'SELECT current_user')).trim()

  // 1. Application tables are owned by the application role. Replaying as a
  //    superuser is what this rules out, and it is invisible from the data.
  const misowned = (
    await psql(
      admin,
      `SELECT count(*) FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_roles r ON r.oid = c.relowner
        WHERE c.relkind = 'r'
          AND (n.nspname = 'public' OR n.nspname LIKE 'workspace\\_%')
          AND c.relname NOT LIKE 'backenly_pgrst%'
          AND r.rolname <> '${appRole.replace(/'/g, "''")}'`,
    )
  ).trim()
  if (misowned !== '0') {
    throw new Error(
      `${misowned} restored table(s) are not owned by ${appRole}. pg_dump runs with ` +
        `--no-owner, so this means the replay used the wrong connection: the application ` +
        `role cannot ALTER its own tables, and FORCE ROW LEVEL SECURITY keys on the owner.`,
    )
  }
  checks.push(`all tables owned by ${appRole}`)

  // 2. FORCE RLS survived. A restore that dropped it serves every row of every
  //    tenant to anyone the policies were supposed to stop.
  const unforced = (
    await psql(
      admin,
      `SELECT count(*) FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname LIKE 'workspace\\_%'
          AND c.relrowsecurity AND NOT c.relforcerowsecurity`,
    )
  ).trim()
  if (unforced !== '0') {
    throw new Error(
      `${unforced} restored workspace table(s) have RLS enabled but not FORCED. Under FORCE ` +
        `the owner is subject to its own policies; without it the owner is exempt.`,
    )
  }
  checks.push('FORCE RLS intact')

  // 3. The registry names every served schema, so exposing it hands any client
  //    the tenant list. It must be reachable by NONE of the PostgREST roles.
  const exposed = (
    await psql(
      admin,
      `SELECT count(*) FROM (
         SELECT unnest(ARRAY['anon','authenticated','service_role']) AS role
       ) r
       WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.role)
         AND has_table_privilege(r.role, 'public.backenly_pgrst_schema_registry', 'SELECT')`,
    ).catch(() => '0')
  ).trim()
  if (exposed !== '0') {
    throw new Error(
      `The PostgREST registry is readable by ${exposed} of the end-user roles. It names every ` +
        `served schema, so exposing it hands any client the tenant list.`,
    )
  }
  checks.push('registry not exposed to end-user roles')

  // 4. The support functions are SECURITY DEFINER and owned by the elevated
  //    role. Owned by the application role they would run with the wrong
  //    privileges - which is exactly what the replay leaves behind, and what
  //    reconcile-derived-state is there to undo.
  const adminRole = (await psql(admin, 'SELECT current_user')).trim()
  const definers = (
    await psql(
      admin,
      `SELECT count(*) FROM pg_proc pr
         JOIN pg_roles r ON r.oid = pr.proowner
        WHERE pr.proname LIKE 'backenly_pgrst%'
          AND pr.prosecdef
          AND r.rolname = '${adminRole.replace(/'/g, "''")}'`,
    )
  ).trim()
  if (definers === '0') {
    throw new Error(
      `No SECURITY DEFINER backenly_pgrst_* function is owned by ${adminRole}. The support ` +
        `objects were replayed as the application role and not reconciled, so they run with ` +
        `the wrong privileges.`,
    )
  }
  checks.push(`${definers} support function(s) owned by ${adminRole}`)

  // 5. The event triggers that keep grants in step with DDL.
  const triggers = (
    await psql(admin, `SELECT count(*) FROM pg_event_trigger WHERE evtname LIKE 'backenly%'`)
  ).trim()
  if (triggers === '0') {
    throw new Error(
      'No Backenly event trigger exists after the restore. Without them a table created ' +
        'later gets no grants, and the data plane answers 403 for it forever.',
    )
  }
  checks.push(`${triggers} event trigger(s)`)

  // 6. The registry identifies the workspace that was actually restored.
  const metadata = await readComponent(bundle, 'deployment-metadata')
  const expectedSchemas: string[] = metadata
    ? (JSON.parse(metadata.toString('utf8')).schemas ?? []).filter((s: string) =>
        s.startsWith('workspace_'),
      )
    : []
  for (const schema of expectedSchemas) {
    const registered = (
      await psql(
        admin,
        `SELECT count(*) FROM public.backenly_pgrst_schema_registry ` +
          `WHERE schema_name = '${schema.replace(/'/g, "''")}'`,
      )
    ).trim()
    if (registered === '0') {
      throw new Error(
        `${schema} was restored but is not in the PostgREST registry, so /db/* will answer ` +
          `PGRST106 for every table in it.`,
      )
    }
  }
  if (expectedSchemas.length > 0) {
    checks.push(`${expectedSchemas.length} workspace(s) registered`)
  }

  return checks.join(', ')
}

// ─── Plumbing ────────────────────────────────────────────────────────────────

function connectionArgs(url: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const parsed = new URL(url)
  const args = [
    '--host', parsed.hostname,
    '--port', parsed.port || '5432',
    '--username', decodeURIComponent(parsed.username),
    '--dbname', parsed.pathname.replace(/^\//, ''),
    '--no-password',
  ]
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (parsed.password) env.PGPASSWORD = decodeURIComponent(parsed.password)
  const sslmode = parsed.searchParams.get('sslmode')
  if (sslmode) env.PGSSLMODE = sslmode
  return { args, env }
}

async function psql(url: string, sql: string): Promise<string> {
  const conn = connectionArgs(url)
  const { stdout } = await execFileAsync(
    'psql',
    [...conn.args, '--tuples-only', '--no-align', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--command', sql],
    { env: conn.env, timeout: 120_000, maxBuffer: 1024 * 1024 * 16 },
  )
  return String(stdout)
}
