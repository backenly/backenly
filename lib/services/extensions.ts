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
 * So the name is not an input. It is a key into a table declared in this file,
 * and anything not in that table is refused before any SQL is composed. Adding
 * an extension is a code change, reviewed.
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
 */

import { Pool } from 'pg'

/** What an allowlisted extension is for, and whether we can install it. */
export interface AllowedExtension {
  name: string
  /** Shown in the dashboard. Why an operator might want this. */
  purpose: string
  /**
   * True when PostgreSQL marks it trusted, so a non-superuser role with CREATE
   * on the database may install it. Checked against the live catalog rather
   * than believed: this is a claim about the running server, and a build of
   * PostgreSQL may disagree with this file.
   */
  expectedTrusted: boolean
  /** Extra requirement this surface cannot satisfy, stated to the operator. */
  caveat?: string
}

/**
 * The extensions Backenly will install on request.
 *
 * Chosen for being useful to a backend, widely packaged, and free of
 * server-level configuration. Everything here ships in the standard `contrib`
 * set, so an operator is not asked to install OS packages first.
 */
export const ALLOWED_EXTENSIONS: readonly AllowedExtension[] = [
  {
    name: 'pgcrypto',
    purpose: 'Hashing and encryption functions, including gen_random_uuid() on older servers.',
    expectedTrusted: true,
  },
  {
    name: 'uuid-ossp',
    purpose: 'UUID generation in the v1/v3/v5 variants that gen_random_uuid() does not cover.',
    expectedTrusted: true,
  },
  {
    name: 'citext',
    purpose: 'Case-insensitive text, for columns like email where LOWER() on every query is the alternative.',
    expectedTrusted: true,
  },
  {
    name: 'pg_trgm',
    purpose: 'Trigram similarity and fast LIKE/ILIKE indexes, for search that is not full-text search.',
    expectedTrusted: true,
  },
  {
    name: 'unaccent',
    purpose: 'Strips accents, so a search for "cafe" matches "café".',
    expectedTrusted: true,
  },
  {
    name: 'hstore',
    purpose: 'Key/value pairs in a single column. Predates jsonb and is still lighter for flat string maps.',
    expectedTrusted: true,
  },
  {
    name: 'ltree',
    purpose: 'Hierarchical label paths, for trees that recursive CTEs make awkward.',
    expectedTrusted: true,
  },
  {
    name: 'btree_gin',
    purpose: 'Lets a GIN index cover ordinary scalar columns alongside jsonb or array columns.',
    expectedTrusted: true,
  },
  {
    name: 'btree_gist',
    purpose: 'Scalar columns inside GiST indexes, which is what exclusion constraints need.',
    expectedTrusted: true,
  },
  {
    name: 'vector',
    purpose: 'Vector similarity search for embeddings.',
    // pgvector is trusted from 0.6, and is not part of contrib: a server that
    // does not have it packaged cannot install it from here at all, which the
    // availability check reports.
    expectedTrusted: true,
    caveat: 'Not part of the standard contrib set. The server must have pgvector packaged.',
  },
  {
    name: 'pg_stat_statements',
    purpose: 'Measured query latency, which Backenly uses to find slow queries by measurement rather than by shape.',
    expectedTrusted: false,
    caveat:
      'Needs superuser AND shared_preload_libraries = \'pg_stat_statements\' in postgresql.conf, ' +
      'followed by a PostgreSQL restart.',
  },
  {
    name: 'pgstattuple',
    purpose: 'Index bloat measurement, which no statistics view exposes.',
    expectedTrusted: false,
    caveat: 'Needs superuser. No restart required.',
  },
] as const

const BY_NAME = new Map(ALLOWED_EXTENSIONS.map(e => [e.name, e]))

/** Is this a name we are willing to compose DDL for? */
export function isAllowedExtension(name: unknown): name is string {
  return typeof name === 'string' && BY_NAME.has(name)
}

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

let pool: Pool | null = null
function getPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  return pool
}

/** Test seam: drop the pool so a suite can point at a different database. */
export async function resetExtensionPool(): Promise<void> {
  if (pool) await pool.end().catch(() => {})
  pool = null
}

/**
 * Every allowlisted extension, with what the live catalog says about it.
 *
 * Ground truth from `pg_available_extensions` and `pg_extension`, never a cached
 * assertion. The register exists because "the code says it supports X" and "the
 * database has X" kept turning out to be different claims.
 */
export async function listExtensions(): Promise<ExtensionStatus[]> {
  const { rows } = await getPool().query<{
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

export type InstallFailureCode = 'NOT_ALLOWED' | 'NOT_AVAILABLE' | 'NEEDS_SUPERUSER' | 'FAILED'

/**
 * Flat rather than a discriminated union, deliberately.
 *
 * This repository compiles with `strict: false`, and a union discriminated on a
 * boolean literal does not narrow under it — `if (!result.ok)` leaves the whole
 * union in scope, so every caller would need a type assertion to read `code`.
 * Assertions at call sites are how a shape drifts from what it claims.
 *
 * Every field is always present instead. `code` and `message` are null on
 * success, `version` is null when nothing was installed.
 */
export interface InstallOutcome {
  ok: boolean
  alreadyInstalled: boolean
  version: string | null
  code: InstallFailureCode | null
  message: string | null
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
export async function installExtension(name: string): Promise<InstallOutcome> {
  if (!isAllowedExtension(name)) {
    return {
      ok: false,
      alreadyInstalled: false,
      version: null,
      code: 'NOT_ALLOWED',
      message:
        `${String(name).slice(0, 60)} is not on Backenly's extension allowlist. ` +
        `Extensions run their own install scripts with the privileges of whoever ` +
        `installs them, so the list is a code change rather than a form field.`,
    }
  }

  const status = (await listExtensions()).find(e => e.name === name)!

  if (status.installed) {
    return { ok: true, alreadyInstalled: true, version: status.installedVersion, code: null, message: null }
  }
  if (!status.available) {
    return { ok: false, alreadyInstalled: false, version: null, code: 'NOT_AVAILABLE', message: status.blockedReason }
  }
  if (!status.installable) {
    return { ok: false, alreadyInstalled: false, version: null, code: 'NEEDS_SUPERUSER', message: status.blockedReason }
  }

  try {
    // Quoted because the name contains a hyphen in at least one case
    // (`uuid-ossp`), and because an unquoted identifier here would be a habit
    // worth not forming.
    await getPool().query(`CREATE EXTENSION IF NOT EXISTS "${name.replace(/"/g, '""')}"`)
  } catch (err: any) {
    // The server's own words. An operator reading "permission denied to create
    // extension" can act; one reading "install failed" cannot.
    return {
      ok: false, alreadyInstalled: false, version: null,
      code: 'FAILED', message: String(err?.message ?? err).slice(0, 400),
    }
  }

  const after = (await listExtensions()).find(e => e.name === name)!
  if (!after.installed) {
    // CREATE EXTENSION reported no error and the catalog disagrees. Reporting
    // success from the absence of an exception is the failure mode this program
    // keeps finding, so the catalog is what is believed.
    return {
      ok: false,
      alreadyInstalled: false,
      version: null,
      code: 'FAILED',
      message: `${name} still does not appear in pg_extension after CREATE EXTENSION reported success.`,
    }
  }

  return { ok: true, alreadyInstalled: false, version: after.installedVersion, code: null, message: null }
}
