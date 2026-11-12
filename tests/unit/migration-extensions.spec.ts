/**
 * CREATE EXTENSION in an agent's migration, and the operator class an index on
 * an extension's type needs (production QA 2026-11-09, report 22).
 *
 * apply_migration refused every CREATE EXTENSION with "describe what you need
 * via backend_chat", which has no way to install one either, and stripped the
 * operator class from `(name gin_trgm_ops)`. So the trigram search a store's
 * ILIKE product search wanted could be made only from the console. The parser
 * now plans the console's install, refuses a name off the allowlist with the
 * console's reason before anything runs, and keeps an index's operator class.
 * Dropping or altering an extension stays refused, with the reason.
 */

import { MigrationParseError, parseMigration } from '@/lib/mcp/migration-parser'

function refusal(sql: string): MigrationParseError {
  try {
    parseMigration(sql)
  } catch (err) {
    expect(err).toBeInstanceOf(MigrationParseError)
    return err as MigrationParseError
  }
  throw new Error(`Expected a refusal for: ${sql}`)
}

describe('CREATE EXTENSION plans the console\'s install', () => {
  it.each([
    ['create extension if not exists pg_trgm with schema extensions;', { name: 'pg_trgm', schema: 'extensions' }],
    ['CREATE EXTENSION pg_trgm', { name: 'pg_trgm' }],
    ['create extension if not exists "uuid-ossp"', { name: 'uuid-ossp' }],
    // Unquoted, as agents write it; PostgreSQL would want the quotes.
    ['create extension if not exists uuid-ossp', { name: 'uuid-ossp' }],
    ["CREATE EXTENSION citext WITH SCHEMA public VERSION '1.6' CASCADE", { name: 'citext', schema: 'public', version: '1.6' }],
    ['create extension citext schema public cascade', { name: 'citext', schema: 'public' }],
  ])('%s', (sql, args) => {
    const steps = parseMigration(sql)
    expect(steps).toEqual([{ tool: 'install_extension', args, source: sql.replace(/;$/, '') }])
  })

  it('runs in the order written, beside the statements that use it', () => {
    const steps = parseMigration(`
      create extension if not exists pg_trgm with schema extensions;
      create index products_name_trgm on products using gin (name gin_trgm_ops);
    `)
    expect(steps.map((s) => s.tool)).toEqual(['install_extension', 'create_index'])
  })

  it('refuses a name off the allowlist, with the console\'s reason, and the whole migration with it', () => {
    const err = refusal('CREATE TABLE notes (body text); CREATE EXTENSION plpython3u')
    expect(err.code).toBe('NOT_ALLOWED')
    expect(err.message).toBe(
      'plpython3u is not on Backenly\'s extension allowlist. Extensions run their own install scripts with the ' +
      'privileges of whoever installs them, so the list is a code change rather than a form field.',
    )
    // The way forward names what can be installed.
    expect(err.hint).toMatch(/pg_trgm/)
    expect(err.hint).toMatch(/citext/)
  })

  it('refuses a clause it does not read, rather than ignoring it', () => {
    expect(refusal("CREATE EXTENSION pg_trgm FROM '1.3'").code).toBe('UNSUPPORTED_STATEMENT')
  })
})

describe('DROP and ALTER EXTENSION stay refused, with the reason', () => {
  it.each(['DROP EXTENSION pg_trgm', 'drop extension if exists pg_trgm cascade'])('%s', (sql) => {
    const err = refusal(sql)
    expect(err.code).toBe('DROP_EXTENSION_REFUSED')
    expect(err.message).toMatch(/never removes an extension/)
    expect(err.message).toMatch(/database-wide/)
    // Not a dead end pointing at backend_chat, which cannot drop one either.
    expect(err.hint).not.toMatch(/backend_chat/)
  })

  it.each(['ALTER EXTENSION pg_trgm UPDATE TO \'1.6\'', 'alter extension citext set schema extensions'])('%s', (sql) => {
    const err = refusal(sql)
    expect(err.code).toBe('ALTER_EXTENSION_REFUSED')
    expect(err.message).toMatch(/database-wide/)
  })
})

describe('an index keeps the operator class written after a column', () => {
  it('USING gin (name gin_trgm_ops), which failed without it', () => {
    const [step] = parseMigration('create index products_name_trgm on products using gin (name gin_trgm_ops)')
    expect(step.args).toEqual({
      tableName: 'products', columns: ['name'], operatorClasses: { name: 'gin_trgm_ops' }, unique: false,
      method: 'gin', indexName: 'products_name_trgm',
    })
  })

  it('USING gin (data jsonb_path_ops), which built a different index without a word', () => {
    const [step] = parseMigration('CREATE INDEX ON events USING gin (data jsonb_path_ops)')
    expect(step.args.operatorClasses).toEqual({ data: 'jsonb_path_ops' })
  })

  it('reads one quoted, qualified by public, with ordering, or on one column of several', () => {
    const [step] = parseMigration(
      'CREATE INDEX ON products (sku, "Title" public.text_pattern_ops DESC NULLS LAST, name "varchar_pattern_ops")',
    )
    expect(step.args.columns).toEqual(['sku', 'Title', 'name'])
    expect(step.args.operatorClasses).toEqual({ Title: 'text_pattern_ops', name: 'varchar_pattern_ops' })
  })

  it('keeps it on a partial index too', () => {
    const [step] = parseMigration('CREATE INDEX ON products USING gin (name gin_trgm_ops) WHERE deleted_at IS NULL')
    expect(step.args.operatorClasses).toEqual({ name: 'gin_trgm_ops' })
    expect(step.args.where).toBe('deleted_at IS NULL')
  })

  it('leaves an index without one exactly as before', () => {
    const [step] = parseMigration('CREATE INDEX ON posts (author_id, created_at DESC)')
    expect(step.args).toEqual({ tableName: 'posts', columns: ['author_id', 'created_at'], unique: false })
  })

  it('refuses a class in a schema extensions are not installed in, and says how to write it', () => {
    const err = refusal('CREATE INDEX ON products USING gin (name extensions.gin_trgm_ops)')
    expect(err.code).toBe('QUALIFIED_NAME')
    expect(err.hint).toMatch(/`name gin_trgm_ops`/)
  })

  it('refuses class parameters rather than dropping them', () => {
    expect(refusal('CREATE INDEX ON products USING gist (name gist_trgm_ops(siglen=32))').code).toBe('UNSUPPORTED_STATEMENT')
  })
})
