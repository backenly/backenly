/**
 * THE TWO RECOVERY PRODUCTS, AND WHAT EACH ONE DOES NOT COVER
 * ==========================================================
 *
 * Written before any implementation, because this is where a platform
 * accidentally promises far more than it restores. An operator who clicks
 * something called "Backup" and concludes their server is safe has been
 * misled by the product, not by their own carelessness.
 *
 * There are exactly two, and they are never the same thing:
 *
 *   PROJECT DATABASE SNAPSHOT
 *     One workspace schema. Tables, rows, indexes, constraints, RLS policies,
 *     and the triggers and functions that live inside that schema.
 *     NOT storage files. NOT platform accounts. NOT API keys. NOT project
 *     configuration or env. NOT function source. NOT deployment config.
 *     Useful for schema/data rollback and for moving a project. It is NOT
 *     disaster recovery and must never be presented as though it were.
 *
 *   DEPLOYMENT RECOVERY BUNDLE
 *     Enough state to rebuild a self-hosted Backenly on a clean machine. This
 *     is the only artifact that may be described as disaster recovery.
 *
 * The distinction is carried in the UI wording too: "Database snapshot" and
 * "Deployment recovery", never a bare "Backup" that could mean either.
 *
 * ── Why the component list is machine-readable ──────────────────────────────
 *
 * Every bundle records which components it actually contains. Without that, a
 * bundle written before storage support existed would be indistinguishable from
 * one whose storage happened to be empty, and a restore would silently produce
 * a deployment missing files nobody knew were absent. The manifest must be able
 * to say "this predates that component" rather than leaving it to be inferred.
 *
 * ── Why the recovery key lives outside the bundle ───────────────────────────
 *
 * A bundle that contains both the encrypted secrets and the key that opens them
 * is not encrypted; it is a tarball with a lock painted on it. Anyone who
 * obtains the file obtains the OAuth client secrets, project env vars and
 * signing secrets inside it.
 *
 * So sensitive sections are encrypted with a per-bundle data key, and that data
 * key is wrapped by an operator-held recovery credential which is never written
 * into the archive. Losing the bundle alone discloses nothing sensitive; losing
 * the bundle AND the recovery credential is the operator's own key-management
 * failure, which is a boundary they can reason about.
 */

import type { WrappedDataKey } from './crypto'

/** Bump when the on-disk shape changes in a way older readers cannot handle. */
export const BUNDLE_FORMAT_VERSION = 1

/**
 * The components a deployment recovery bundle can carry.
 *
 * Recorded per bundle rather than assumed, so an older archive cannot be read
 * as though it contained something that did not exist when it was written.
 */
export const RECOVERY_COMPONENTS = [
  /** The platform database: projects, users, keys metadata, autonomy state. */
  'platform-database',
  /** Every `workspace_<projectId>` schema, with data. */
  'workspace-schemas',
  /** Stored objects plus the metadata rows that describe them. */
  'storage-objects',
  /** Serverless function definitions and their source. */
  'function-definitions',
  /** Per-project configuration and environment, encrypted. */
  'project-secrets',
  /** Which account owns the deployment, and admin role assignments. */
  'operator-ownership',
  /** Backenly version, Prisma schema version, required PostgreSQL extensions. */
  'deployment-metadata',
] as const

export type RecoveryComponent = (typeof RECOVERY_COMPONENTS)[number]

/**
 * Components readable WITHOUT the recovery credential.
 *
 * Deliberately tiny, and the inverse is the interesting half: everything else
 * is encrypted. An earlier draft encrypted only `project-secrets`, which was
 * theatre - the platform dump beside it carries `Project.jwtSecret`, every
 * password hash, every API key record and every stored provider credential in
 * the clear, and the workspace dumps carry end-user password hashes. Encrypting
 * the small named box while the large unnamed one sits open next to it protects
 * nothing.
 *
 * `deployment-metadata` stays readable on purpose. A reader has to be able to
 * answer "is this the right bundle, and can this build even restore it?" BEFORE
 * anyone goes and fetches the credential. It holds versions and an extension
 * list, and nothing that identifies a person.
 */
export const PLAINTEXT_COMPONENTS: readonly RecoveryComponent[] = [
  'deployment-metadata',
]

/** Components whose contents are encrypted under the recovery credential. */
export const ENCRYPTED_COMPONENTS: readonly RecoveryComponent[] =
  RECOVERY_COMPONENTS.filter(c => !PLAINTEXT_COMPONENTS.includes(c))

export interface ComponentEntry {
  component: RecoveryComponent
  /** Path inside the bundle. */
  path: string
  bytes: number
  /** SHA-256 of the file as written, so corruption is detected before use. */
  sha256: string
  /** True when this entry is encrypted under the bundle data key. */
  encrypted: boolean
  /**
   * Present and empty is different from absent.
   *
   * A deployment with no storage objects writes this component with zero
   * items; a bundle that predates storage support omits the component
   * entirely. Only the second is ambiguous, and recording both removes the
   * ambiguity.
   */
  items: number
}

export interface RecoveryManifest {
  formatVersion: number
  /** ISO-8601, when the bundle was written. */
  createdAt: string
  /** The Backenly build that wrote it. */
  backenlyVersion: string
  /** Prisma migration the platform database was at. */
  schemaVersion: string
  /** PostgreSQL server version the source ran on. */
  postgresVersion: string
  /** Extensions the restore target must be able to provide. */
  requiredExtensions: string[]
  /** Exactly what this bundle contains. Absence is meaningful. */
  components: ComponentEntry[]
  /**
   * The per-bundle data key, wrapped by the operator's recovery credential.
   * The credential itself is NEVER present in the bundle.
   *
   * The shape lives in ./crypto beside the code that produces it, including the
   * KDF cost it was written with - so raising that cost later does not make
   * older bundles unreadable.
   */
  wrappedDataKey: WrappedDataKey | null
}

/**
 * The order a restore must follow.
 *
 * Deterministic and dependency-ordered: workspace schemas need roles and
 * extensions, storage metadata references projects, secrets must be re-wrapped
 * under the TARGET deployment's key rather than the source's, and derived state
 * has to be reconciled only once everything it derives from exists.
 *
 * Nothing in this list may touch a live installation before validation has
 * passed over the whole archive. The workspace backup path learned that the
 * expensive way: it dropped a schema and then discovered the dump was
 * unreadable, which is terminal however loudly it fails afterwards.
 */
export const RESTORE_ORDER = [
  'validate-manifest',
  'validate-checksums',
  'validate-version-compatibility',
  'provision-database-roles-and-extensions',
  'restore-platform-database',
  'restore-workspace-schemas',
  'restore-storage-objects',
  'restore-function-definitions',
  'rewrap-secrets-for-target',
  'reconcile-derived-state',
  'verify-health-and-integrity',
] as const

export type RestoreStep = (typeof RESTORE_ORDER)[number]

/** Steps that only read the archive. Everything after the last one mutates. */
export const VALIDATION_STEPS: readonly RestoreStep[] = [
  'validate-manifest',
  'validate-checksums',
  'validate-version-compatibility',
]

/** True when this step changes the target deployment. */
export function mutatesTarget(step: RestoreStep): boolean {
  return !VALIDATION_STEPS.includes(step)
}

export class RecoveryContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecoveryContractError'
  }
}

/**
 * Refuse a bundle this build cannot honestly restore.
 *
 * A newer bundle may name components this build has never heard of. Restoring
 * it would produce a deployment silently missing them, which is worse than
 * refusing: the operator would believe recovery succeeded.
 */
export function assertRestorable(manifest: RecoveryManifest): void {
  if (manifest.formatVersion > BUNDLE_FORMAT_VERSION) {
    throw new RecoveryContractError(
      `This bundle is format version ${manifest.formatVersion}; this build understands ${BUNDLE_FORMAT_VERSION}. ` +
      `Restore it with a Backenly at least as new as the one that wrote it.`,
    )
  }

  const known = new Set<string>(RECOVERY_COMPONENTS)
  const unknown = manifest.components.map(c => c.component).filter(c => !known.has(c))
  if (unknown.length > 0) {
    throw new RecoveryContractError(
      `This bundle contains components this build does not know how to restore: ${unknown.join(', ')}. ` +
      `Restoring it would produce a deployment silently missing them.`,
    )
  }
}

/**
 * What a bundle does NOT contain, stated positively.
 *
 * Used by the UI and the CLI so the answer comes from the manifest rather than
 * from a sentence somebody wrote once and forgot to update.
 */
export function missingComponents(manifest: RecoveryManifest): RecoveryComponent[] {
  const present = new Set(manifest.components.map(c => c.component))
  return RECOVERY_COMPONENTS.filter(c => !present.has(c))
}

/**
 * WHAT RECOVERY CARRIES ACROSS, AND WHAT IT DELIBERATELY DROPS
 * ===========================================================
 *
 * A bundle that restores everything restores too much. But the line is not
 * "secret vs not secret", and it is not "auth-related vs not" either — an
 * earlier draft of this file dropped the JWT denylist on that reasoning, which
 * would have un-revoked every revoked end-user token. See below.
 *
 * THE TEST, applied to each credential in turn:
 *
 *   1. Does dropping it FAIL CLOSED? A row that is looked up to GRANT access
 *      can be dropped safely; its absence denies. A row that is looked up to
 *      DENY access must never be dropped; its absence allows.
 *
 *   2. Can the holder re-establish it through a normal interactive flow?
 *      A person signs in again. An MCP client re-runs OAuth. But an API key is
 *      baked into someone else's CI, and a human has to go and change it — so
 *      dropping it breaks callers silently with nobody in the loop.
 *
 * Drop only when both hold. Otherwise carry.
 *
 * Identity is durable; proof of a past login is not. After recovery a user's
 * account, password hash and second factor are intact, and they sign in again.
 *
 * WHY THIS IS KEYED BY TABLE NAME
 * -------------------------------
 * Because the list is load-bearing, not documentation: `droppedTableData()`
 * below is what the exporter turns into pg_dump arguments. A prose list would
 * drift from the schema silently, which is the failure mode
 * docs/mcp-catalog-truth-architecture.md records the platform already paid for
 * once. `recovery-contract.spec.ts` reads prisma/schema.prisma and fails when a
 * credential-shaped model has no entry here, so adding one forces a decision
 * rather than defaulting to whatever the exporter happens to do.
 */

export type Disposition = 'carry' | 'drop'

/**
 * Every credential-shaped table in the platform database.
 *
 * Dropping means the table is restored EMPTY, not omitted: the application
 * expects it to exist. See `droppedTableData`.
 */
export const PLATFORM_CREDENTIAL_TABLES: Readonly<Record<string, Disposition>> = {
  // ─── Carried ────────────────────────────────────────────────────────────
  /** Identity itself, password hash included. Recovery without it is not recovery. */
  users: 'carry',
  /** Baked into other people's code and CI. A human would have to go and rotate them. */
  api_keys: 'carry',
  /** History, not a credential. */
  api_key_usage: 'carry',
  /** The user holds these offline and cannot re-issue them without signing in first. */
  two_factor_backup_codes: 'carry',
  /** Project OAuth configuration. External clients are configured against it. */
  auth_providers: 'carry',
  auth_policies: 'carry',
  workspace_oauth_configs: 'carry',
  project_auth_configs: 'carry',
  /** Credentials this deployment uses to call OUT. Re-entering them is manual. */
  provider_credentials: 'carry',
  /** Connection credentials handed to external tools. Same argument as api_keys. */
  database_credentials: 'carry',
  /** Registered MCP client identities; the client secret lives in the client's own config. */
  mcp_oauth_clients: 'carry',
  /** Shared externally and long-lived. */
  referral_codes: 'carry',
  /**
   * Borderline, decided as carry and written down rather than decided silently.
   * Share links are meant to be long-lived, the lookup is by hash so absence
   * denies, and `revokedAt` rides along on the row — so carrying cannot
   * resurrect a revoked link, while dropping would break live ones.
   */
  share_tokens: 'carry',

  // ─── Dropped ────────────────────────────────────────────────────────────
  /**
   * A human's standing permission for Backenly to mutate unattended.
   *
   * Both tests hold. It is looked up to GRANT, so its absence denies and the
   * loop falls back to proposing rather than acting. And the owner re-creates it
   * through the same interactive flow they used the first time; nothing external
   * holds a copy.
   *
   * The safety argument is stronger than either, though: a restore must never
   * resurrect authority a person withdrew. Carrying these would mean a grant
   * revoked on Tuesday could come back with a Wednesday restore, and Backenly
   * would resume changing a backend under permission the owner had taken away.
   */
  authority_grants: 'drop',
  /** DB-backed, so absence denies, and signing in again is trivial. */
  sessions: 'drop',
  /**
   * One-time, minutes-long, and very likely already spent or cancelled. A
   * pending signup in here also holds a password hash for an account that does
   * not exist yet; the person simply signs up again.
   */
  auth_email_codes: 'drop',
  oauth_authorization_codes: 'drop',
  mcp_oauth_codes: 'drop',
  /** Short-lived bearer tokens with a re-issue path. */
  oidc_access_tokens: 'drop',
  /**
   * The long-lived bearer an operator most wants gone after an incident, and
   * MCP clients re-run the authorization flow on their own.
   */
  mcp_oauth_refresh_tokens: 'drop',
}

/**
 * The per-project workspace tables holding end-user auth state.
 *
 * `_token_blacklist` goes the other way from everything around it, and the
 * reason is worth stating. End-user JWTs are STATELESS, signed with the
 * project's own secret, which recovery carries — so a token revoked before the
 * bundle was written still verifies after the restore. The denylist is the only
 * thing that refuses it, and `lib/api/v1/middleware.ts` treats a missing table
 * as "not blacklisted". Dropping it would silently un-revoke every revoked
 * token, with no error anywhere. It fails OPEN, which is rule 1 above.
 */
export const WORKSPACE_CREDENTIAL_TABLES: Readonly<Record<string, Disposition>> = {
  _token_blacklist: 'carry',
  _magic_links: 'drop',
  _password_resets: 'drop',
  /** Pending tokens only. Whether an address IS verified is a column on the users table. */
  _email_verifications: 'drop',
}

/** Credentials that are not rows in a table of their own. */
export const NON_TABLE_CREDENTIALS: Readonly<Record<string, Disposition>> = {
  /** Signs every end-user JWT. Issuing a new one invalidates every client at once. */
  'project.jwtSecret': 'carry',
  /** Embedded in client bundles. */
  'project.anonKey': 'carry',
  'project.envVars': 'carry',
  /**
   * Its entire purpose is to claim an UNCLAIMED deployment, so restoring it
   * into a claimed one would reintroduce the exact credential the claim
   * consumed.
   */
  'deployment.setupToken': 'drop',
}

const ALL_CREDENTIALS: Readonly<Record<string, Disposition>> = {
  ...PLATFORM_CREDENTIAL_TABLES,
  ...WORKSPACE_CREDENTIAL_TABLES,
  ...NON_TABLE_CREDENTIALS,
}

/** Restored as-is. Something outside this deployment depends on the value. */
export const DURABLE_CREDENTIALS: readonly string[] = Object.keys(ALL_CREDENTIALS)
  .filter(k => ALL_CREDENTIALS[k] === 'carry')
  .sort()

/** Deliberately not restored, even though they sit beside the durable ones. */
export const EPHEMERAL_CREDENTIALS: readonly string[] = Object.keys(ALL_CREDENTIALS)
  .filter(k => ALL_CREDENTIALS[k] === 'drop')
  .sort()

/**
 * What recovery does with a named credential.
 *
 * Throws on anything unclassified rather than guessing. An exporter that
 * silently carried an unknown credential-shaped table is precisely the bug this
 * section exists to prevent.
 */
export function dispositionOf(name: string): Disposition {
  const d = ALL_CREDENTIALS[name]
  if (!d) {
    throw new RecoveryContractError(
      `No recovery disposition for ${JSON.stringify(name)}. ` +
      `Classify it in lib/recovery/contract.ts as 'carry' or 'drop' before exporting it.`,
    )
  }
  return d
}

/** A credential the restore must drop rather than carry across. */
export function isEphemeral(name: string): boolean {
  return dispositionOf(name) === 'drop'
}

/**
 * The tables whose DATA the export omits, split by where they live.
 *
 * Data, not the tables themselves: pg_dump's `--exclude-table-data` keeps the
 * structure so the application still finds what it expects, and the rows are
 * simply absent. Omitting the tables outright would leave a restored
 * deployment that cannot sign anybody in.
 */
export function droppedTableData(): { platform: string[]; workspace: string[] } {
  const drop = (r: Readonly<Record<string, Disposition>>) =>
    Object.keys(r).filter(k => r[k] === 'drop').sort()
  return {
    platform: drop(PLATFORM_CREDENTIAL_TABLES),
    workspace: drop(WORKSPACE_CREDENTIAL_TABLES),
  }
}

/**
 * SUBSYSTEMS THAT MUST BE SILENT WHILE A RESTORE IS IN FLIGHT.
 * ===========================================================
 *
 * A half-restored deployment is a deployment describing a state that was true
 * in the past. Anything that acts on state autonomously will act on that
 * description, and the actions reach the outside world where they cannot be
 * taken back.
 *
 * Concretely: webhook delivery would re-send events whose recipients already
 * processed them; email would re-send verifications and invitations; cron and
 * background jobs would re-run work already done; function invocations would
 * bill and mutate; and autonomy would observe a deliberately partial schema,
 * diagnose it as broken, and "repair" it — fighting the restore step by step.
 *
 * These stay off until `verify-health-and-integrity` passes, not until the last
 * write completes. A restore that finished writing is not yet a restore that
 * worked.
 */
export const QUIESCED_SUBSYSTEMS = [
  'cron-scheduler',
  'autonomy-reconciler',
  'webhook-delivery',
  'email-delivery',
  'background-jobs',
  'function-invocation',
] as const

export type QuiescedSubsystem = (typeof QUIESCED_SUBSYSTEMS)[number]

/** True when this subsystem may run at the given point in the restore. */
export function subsystemMayRun(step: RestoreStep, completed: boolean): boolean {
  // Only after the FINAL step has completed successfully. During any step,
  // including the last one while it is still running, everything stays off.
  return completed && step === 'verify-health-and-integrity'
}
