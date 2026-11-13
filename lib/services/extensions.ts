/**
 * POSTGRESQL EXTENSIONS, THROUGH AN ALLOWLIST
 * ===========================================
 *
 * The platform already KNEW about extensions. `lib/autonomy/platform-capabilities.ts`
 * reads `pg_extension` to find out whether `pg_stat_statements` and `pgstattuple`
 * are installed, and when they are not it prints the `CREATE EXTENSION` an
 * operator should run by hand. So detection existed and the operator surface did
 * not: the register called this a REAL_GAP, correctly.
 *
 * ── Why an allowlist rather than a text box ─────────────────────────────────
 *
 * `CREATE EXTENSION` runs arbitrary SQL from the extension's install script,
 * with the privileges of whoever runs it. An extension name taken from a request
 * and interpolated into DDL is not "a form field", it is remote code execution
 * with extra steps — and quoting the identifier does not help, because the
 * danger is the script the name selects, not the syntax.
 *
 * So the name is not an input. It is a key into a table declared in
 * ./extension-allowlist.ts, and anything not in that table is refused before
 * any SQL is composed. Adding an extension is a code change, reviewed.
 *
 * This is the same reasoning AGENTS.md gives for refusing a dashboard SQL
 * editor: a parser must never be the boundary. Here the boundary is that there
 * is nothing to parse.
 *
 * ── What PostgreSQL will actually permit ────────────────────────────────────
 *
 * PostgreSQL 13 introduced TRUSTED extensions: a role with CREATE on the
 * database may install one without being superuser. Everything else needs
 * superuser, and the application role is deliberately NOSUPERUSER — that is the
 * whole point of the role split, and this surface does not get to undo it.
 *
 * So the allowlist carries both kinds and reports them differently. A trusted
 * extension gets an Install button that works. A superuser-only one is listed
 * with the exact command and the reason, which is what the capability notices
 * already do. Offering a button that always fails would be worse than offering
 * none.
 *
 * ── No DROP EXTENSION ───────────────────────────────────────────────────────
 *
 * Deliberately absent. `DROP EXTENSION` cascades to every object that depends on
 * it — columns typed by it, indexes using its operator classes — and the
 * dashboard has no way to show an operator what a CASCADE would take with it.
 * An extension left installed costs nothing; one dropped out from under a live
 * schema costs data. Removing one is a deliberate act at a psql prompt.
 *
 * ── Agents install them too ─────────────────────────────────────────────────
 *
 * A coding agent writes `CREATE EXTENSION [IF NOT EXISTS] name [WITH] [SCHEMA s]
 * [VERSION v] [CASCADE]` in apply_migration (lib/mcp/migration-parser.ts), and
 * it arrives here as the console's Install button does: the same allowlist, the
 * same live checks, the same refusals in the same words. Neither door drops or
 * alters one. Both install into one schema, `public` (EXTENSION_SCHEMA in
 * ./extension-allowlist.ts says why), whatever SCHEMA the statement named, and
 * the server's default version: the result says where it is and which version.
 *
 * Installing one waits for nobody, on a protected production too. Protection
 * (lib/branches/protection.ts) is about a project's schema: production's tables
 * change only through a merge a person approved. An extension creates nothing
 * in any project's schema, and the index or column that uses it is a schema
 * change, which still goes through the branch and that merge. Nor does it
 * change what production accepts or returns, which is what holds a migration
 * step for a person (REVIEWED_BEFORE_PRODUCTION in lib/mcp/apply-migration.ts).
 * And it takes no more authority than the console asks for: the console
 * installs at ADMIN, and ADMIN is the rank that issues an agent a read-write
 * key (app/api/projects/[id]/mcp/keys) or connection (the OAuth consent). What
 * Backenly cannot do is undo an install, which is why removal, not
 * installation, is what no door offers.
 *
 * On a preview branch an install is not the branch's own: the extension is
 * installed for the whole database, production included, and the result says
 * so. The merge replays the statement, which then finds it installed.
 *
 * ── Recorded ────────────────────────────────────────────────────────────────
 *
 * Every install, from either door, is an `EXTENSION_INSTALLED` audit row on the
 * project it was asked through, which that project's activity feed shows. It
 * is not a History change of its own: History restores a project's backend,
 * and nothing restores this. When the migration that installs one also changes
 * the schema, that change in History lists the install among its steps, with
 * its statement, and restoring the change leaves the extension where it is.
 */

import { Pool } from 'pg'
import { disconnectRegionalClients, projectPool } from '@/lib/data-plane/regional'
import {
  ALLOWED_EXTENSIONS,
  EXTENSION_SCHEMA,
  databaseWide,
  isAllowedExtension,
  notAllowedReason,
  type AllowedExtension,
} from './extension-allowlist'

export { ALLOWED_EXTENSIONS, EXTENSION_SCHEMA, databaseWide, isAllowedExtension, notAllowedReason, type AllowedExtension }

export interface ExtensionStatus extends AllowedExtension {
  /** Present on this server's disk, so installable in principle. */
  available: boolean
  /** Currently installed in this database. */
  installed: boolean
  installedVersion: string | null
  defaultVersion: string | null
  /** The schema it was installed into, when it is installed. */
  schema: string | null
  /** What the SERVER says, which overrides `expectedTrusted`. */
  trusted: boolean | null
  /**
   * Whether this surface will offer to install it.
   *
   * False for anything the application role cannot install, so the dashboard
   * never shows a button whose only possible outcome is a permissions error.
   */
  installable: boolean
  /** Why it is not installable, when it is not. */
  blockedReason: string | null
}

/**
 * The project's own database, in its region: extensions are installed per
 * database, so a regional project's live in its region's database.
 */
function getPool(projectId: string): Promise<Pool> {
  return projectPool(projectId, 'extensions', { max: 2 })
}

/** Test seam: drop the pools so a suite can point at a different database. */
export async function resetExtensionPool(): Promise<void> {
  await disconnectRegionalClients()
}

/**
 * Every allowlisted extension, with what the live catalog says about it.
 *
 * Ground truth from `pg_available_extensions` and `pg_extension`, never a cached
 * assertion. The register exists because "the code says it supports X" and "the
 * database has X" kept turning out to be different claims.
 */
export async function listExtensions(projectId: string): Promise<ExtensionStatus[]> {
  const { rows } = await (await getPool(projectId)).query<{
    name: string
    default_version: string | null
    installed_version: string | null
    trusted: boolean | null
    schema: string | null
  }>(
    `SELECT ae.name,
            ae.default_version,
            ae.installed_version,
            v.trusted,
            n.nspname AS schema
       FROM pg_available_extensions ae
       LEFT JOIN pg_available_extension_versions v
              ON v.name = ae.name AND v.version = ae.default_version
       LEFT JOIN pg_extension e ON e.extname = ae.name
       LEFT JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE ae.name = ANY($1::text[])`,
    [ALLOWED_EXTENSIONS.map(e => e.name)],
  )

  const found = new Map(rows.map(r => [r.name, r]))

  return ALLOWED_EXTENSIONS.map(entry => {
    const row = found.get(entry.name)
    const available = Boolean(row)
    const installed = Boolean(row?.installed_version)
    // The server's answer wins. `expectedTrusted` is what this file believes;
    // a packaged build can disagree, and the catalog is what CREATE EXTENSION
    // will actually obey.
    const trusted = row?.trusted ?? null

    let installable = false
    let blockedReason: string | null = null

    if (installed) {
      blockedReason = null
    } else if (!available) {
      blockedReason = `This server does not have ${entry.name} available to install.`
    } else if (trusted === false) {
      blockedReason =
        entry.caveat ??
        `${entry.name} is not a trusted extension, so PostgreSQL requires a superuser to install it.`
    } else {
      installable = true
    }

    return {
      ...entry,
      available,
      installed,
      installedVersion: row?.installed_version ?? null,
      defaultVersion: row?.default_version ?? null,
      schema: row?.schema ?? null,
      trusted,
      installable,
      blockedReason,
    }
  })
}

export type InstallFailureCode = 'NOT_ALLOWED' | 'NOT_AVAILABLE' | 'NEEDS_SUPERUSER' | 'VERSION_NOT_OFFERED' | 'FAILED'

/**
 * Flat rather than a discriminated union, deliberately.
 *
 * This repository compiles with `strict: false`, and a union discriminated on a
 * boolean literal does not narrow under it — `if (!result.ok)` leaves the whole
 * union in scope, so every caller would need a type assertion to read `code`.
 * Assertions at call sites are how a shape drifts from what it claims.
 *
 * Every field is always present instead. `code` and `message` are null on
 * success, `version` and `schema` are null when nothing is installed.
 */
export interface InstallOutcome {
  ok: boolean
  alreadyInstalled: boolean
  version: string | null
  /** Where it is installed: EXTENSION_SCHEMA, unless someone put it elsewhere first. */
  schema: string | null
  code: InstallFailureCode | null
  message: string | null
}

export interface InstallOptions {
  /** A VERSION the caller named. Only the server's default version is installed. */
  version?: string | null
  /** Who asked, and through which door: for the audit row a fresh install writes. */
  actor?: { userId?: string | null; via: 'console' | 'agent' }
}

/**
 * Whether `name` can be installed here, from the allowlist and the live
 * catalog, without changing anything. installExtension asks it first, and an
 * agent's migration asks it before its first statement runs, so a refusal there
 * leaves nothing half-applied. The reasons are the console's.
 */
export async function checkInstall(
  projectId: string,
  name: string,
  opts: Pick<InstallOptions, 'version'> = {},
): Promise<{ ok: boolean; status: ExtensionStatus | null; code: InstallFailureCode | null; message: string | null }> {
  if (!isAllowedExtension(name)) {
    return { ok: false, status: null, code: 'NOT_ALLOWED', message: notAllowedReason(name) }
  }
  const status = (await listExtensions(projectId)).find(e => e.name === name)!
  if (status.installed) return { ok: true, status, code: null, message: null }
  if (!status.available) return { ok: false, status, code: 'NOT_AVAILABLE', message: status.blockedReason }
  if (!status.installable) return { ok: false, status, code: 'NEEDS_SUPERUSER', message: status.blockedReason }
  const version = opts.version?.trim()
  if (version && status.defaultVersion && version !== status.defaultVersion) {
    return {
      ok: false,
      status,
      code: 'VERSION_NOT_OFFERED',
      message:
        `Backenly installs the version of ${name} this server offers by default, ${status.defaultVersion}, ` +
        `and VERSION '${version.slice(0, 20)}' was asked for.`,
    }
  }
  return { ok: true, status, code: null, message: null }
}

/**
 * Install one allowlisted extension.
 *
 * The name is validated against the allowlist BEFORE any SQL exists, so there is
 * no composed statement to escape from. It is then quoted anyway, as
 * defence in depth rather than as the control.
 *
 * `IF NOT EXISTS` so a second click is not an error, and the outcome says which
 * happened rather than reporting a no-op as a fresh install.
 */
export async function installExtension(projectId: string, name: string, opts: InstallOptions = {}): Promise<InstallOutcome> {
  const check = await checkInstall(projectId, name, opts)
  if (!check.ok) {
    return { ok: false, alreadyInstalled: false, version: null, schema: null, code: check.code, message: check.message }
  }
  const status = check.status!
  if (status.installed) {
    return { ok: true, alreadyInstalled: true, version: status.installedVersion, schema: status.schema, code: null, message: null }
  }

  // Quoted because the name contains a hyphen in at least one case
  // (`uuid-ossp`), and because an unquoted identifier here would be a habit
  // worth not forming. The schema is named rather than left to whatever
  // search_path this connection has, so the console and an agent's migration
  // put it in the same place.
  const sql = `CREATE EXTENSION IF NOT EXISTS "${name.replace(/"/g, '""')}" WITH SCHEMA ${EXTENSION_SCHEMA}`
  try {
    await (await getPool(projectId)).query(sql)
  } catch (err: any) {
    // The server's own words. An operator reading "permission denied to create
    // extension" can act; one reading "install failed" cannot.
    return {
      ok: false, alreadyInstalled: false, version: null, schema: null,
      code: 'FAILED', message: String(err?.message ?? err).slice(0, 400),
    }
  }
  // Sent on a connection of its own, which the change's recorder does not see:
  // put on the record of the agent's migration it ran in, when there is one.
  const { currentChange, recordStatement } = await import('@/lib/changes/ledger')
  const change = currentChange(projectId)
  if (change) recordStatement(change, sql)

  const after = (await listExtensions(projectId)).find(e => e.name === name)!
  if (!after.installed) {
    // CREATE EXTENSION reported no error and the catalog disagrees. Reporting
    // success from the absence of an exception is the failure mode this program
    // keeps finding, so the catalog is what is believed.
    return {
      ok: false,
      alreadyInstalled: false,
      version: null,
      schema: null,
      code: 'FAILED',
      message: `${name} still does not appear in pg_extension after CREATE EXTENSION reported success.`,
    }
  }

  await recordInstall(projectId, name, after, opts.actor)
  return { ok: true, alreadyInstalled: false, version: after.installedVersion, schema: after.schema, code: null, message: null }
}

/** The audit row an install leaves on the project it was asked through. Never fails the install. */
async function recordInstall(
  projectId: string,
  name: string,
  status: ExtensionStatus,
  actor: InstallOptions['actor'],
): Promise<void> {
  try {
    const { prisma } = await import('@/lib/db/prisma')
    const { currentAttribution } = await import('@/lib/changes/attribution')
    const apiKeyId = currentAttribution()?.apiKeyId
    await prisma.auditLog.create({
      data: {
        projectId,
        userId: actor?.userId ?? null,
        action: 'EXTENSION_INSTALLED',
        type: 'database',
        details: JSON.stringify({
          extension: name,
          version: status.installedVersion,
          schema: status.schema,
          via: actor?.via ?? null,
          ...(apiKeyId ? { apiKeyId } : {}),
        }),
        timestamp: new Date(),
      },
    })
  } catch (err) {
    console.warn(`[extensions] project=${projectId}: the install of ${name} was not recorded:`, err instanceof Error ? err.message : err)
  }
}

/**
 * What an install did, in one paragraph for whoever asked: where it is, that it
 * is database-wide and stays, and which part of what was asked was not used.
 */
export function describeInstall(
  name: string,
  outcome: InstallOutcome,
  asked: { schema?: string | null; version?: string | null } = {},
): string {
  const version = outcome.version ? ` ${outcome.version}` : ''
  const where = outcome.schema ? ` in schema ${outcome.schema}` : ''
  const lines = [
    outcome.alreadyInstalled
      ? `${name}${version} was already installed${where}, so nothing changed.`
      : `Installed ${name}${version}${where}.`,
    databaseWide(name),
  ]
  if (outcome.schema && outcome.schema !== EXTENSION_SCHEMA) {
    lines.push(
      `It is in schema ${outcome.schema}, not ${EXTENSION_SCHEMA}, so a project's API roles find its functions ` +
      `only where ${outcome.schema} is on their search path.`,
    )
  } else if (asked.schema && asked.schema !== EXTENSION_SCHEMA) {
    lines.push(
      `SCHEMA ${asked.schema} was not used: Backenly installs every extension into ${EXTENSION_SCHEMA}, which ` +
      `every project's API roles already search, so write its functions and operator classes unqualified.`,
    )
  }
  if (asked.version && outcome.version && asked.version !== outcome.version) {
    lines.push(`VERSION '${asked.version}' was not used: ${name} is installed at ${outcome.version}, and Backenly does not change an installed extension's version.`)
  }
  return lines.join(' ')
}

/**
 * A migration's install_extension step (lib/mcp/migration-parser.ts), as
 * apply_migration runs it on production and on a preview branch: the console's
 * install, with the result written for the agent that asked.
 */
export async function installForMigration(
  projectId: string,
  args: Record<string, unknown>,
  userId?: string | null,
): Promise<{ ok: boolean; summary: string; code?: string; outcome: InstallOutcome }> {
  const name = String(args.name ?? '')
  const version = typeof args.version === 'string' ? args.version : null
  const schema = typeof args.schema === 'string' ? args.schema : null
  const outcome = await installExtension(projectId, name, { version, actor: { userId: userId ?? null, via: 'agent' } })
  if (!outcome.ok) {
    return { ok: false, summary: outcome.message ?? `${name} was not installed.`, code: outcome.code ?? 'FAILED', outcome }
  }
  return { ok: true, summary: describeInstall(name, outcome, { schema, version }), outcome }
}
