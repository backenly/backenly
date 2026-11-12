/**
 * The extensions Backenly installs, and the words both doors use about them.
 *
 * Pure data, apart from lib/services/extensions.ts (which reads the catalog and
 * runs the DDL), so the migration parser can refuse a name off the list without
 * importing a database client. Why there is a list at all, and why it never
 * removes anything, is the header of lib/services/extensions.ts.
 */

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
 * set, so an operator is not asked to install OS packages first. None of them
 * requires another extension, so CASCADE never has anything to install.
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
    name: 'fuzzystrmatch',
    purpose: 'Edit distance and sound-alike matching (levenshtein, soundex, metaphone), for search that forgives typos.',
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

/**
 * The one schema Backenly installs extensions into.
 *
 * An extension exists once per database, so on a database several projects
 * share, wherever the first install puts it is where it is for all of them.
 * Backenly decides that instead of the first caller: always `public`, from the
 * console and from an agent's migration alike.
 *
 * `public` is the schema every project's own roles already resolve. Both REST
 * dialects are served by PostgREST, which runs a request as anon, authenticated
 * or service_role with `workspace_<id>, public` as its search_path (public is
 * its default extra search path), and PostgreSQL grants USAGE on public to
 * PUBLIC. So those roles find an extension's functions, operators and types
 * there without a qualifier. Any other schema would need a grant and a
 * search_path change for every role before a project could use what it
 * installed, and the search_path is deployment configuration.
 */
export const EXTENSION_SCHEMA = 'public'

/** Why a name off the list is refused. One sentence for every door. */
export function notAllowedReason(name: unknown): string {
  return (
    `${String(name).slice(0, 60)} is not on Backenly's extension allowlist. ` +
    `Extensions run their own install scripts with the privileges of whoever ` +
    `installs them, so the list is a code change rather than a form field.`
  )
}

/** What installing one means on a shared database, said wherever one is installed. */
export function databaseWide(name: string): string {
  return (
    `Extensions are database-wide: every project on this database can use ${name}, ` +
    `and Backenly never removes an extension.`
  )
}
