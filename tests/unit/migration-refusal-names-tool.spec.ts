import { parseMigration, MigrationParseError } from '@/lib/mcp/migration-parser'

/**
 * apply_migration's own description promises refusals come "with the exact tool
 * to use instead". A refusal that names no tool leaves an agent with nowhere to
 * go, which is how a supported capability gets reported as impossible.
 */
const TOOL_NAMES = /\b(set_rls|add_rls|backend_chat|run_query|db_insert|db_update|db_delete|add_constraint|create_index|generate_types|read_backend_state|get_table_schema|UNIQUE)\b/

function refusalFor(sql: string): MigrationParseError {
  try {
    parseMigration(sql, { tableExists: () => true, columnsOf: () => [] } as any)
  } catch (e) {
    if (e instanceof MigrationParseError) return e
    throw e
  }
  throw new Error(`Expected a refusal for: ${sql}`)
}

describe('every apply_migration refusal names the route forward (#8)', () => {
  const cases: Array<[string, string]> = [
    ['RLS', 'CREATE POLICY p ON posts FOR SELECT USING (true)'],
    ['enable RLS', 'ALTER TABLE posts ENABLE ROW LEVEL SECURITY'],
    ['a read', 'SELECT * FROM posts'],
    ['an unsupported type', 'CREATE TABLE t (mood mood_enum)'],
    ['an unsupported array element', 'CREATE TABLE t (m mood_enum[])'],
    ['a primary key', 'CREATE TABLE t (a text, PRIMARY KEY (a))'],
    ['EXCLUDE', 'CREATE TABLE t (a text, CONSTRAINT x EXCLUDE USING gist (a WITH =))'],
  ]

  it.each(cases)('refusing %s names a tool or the supported form', (_label, sql) => {
    const err = refusalFor(sql)
    const text = `${err.message} ${(err as any).hint ?? ''}`
    expect(text).toMatch(TOOL_NAMES)
  })

  it('the RLS refusal points at set_rls and shows the translation', () => {
    const err = refusalFor('CREATE POLICY p ON posts FOR SELECT USING (owner = 1)')
    const text = `${err.message} ${(err as any).hint ?? ''}`
    expect(text).toContain('set_rls')
    expect(text).toMatch(/using/i)
    expect(text).toMatch(/check/i)
  })

  it('multi-column CHECK is ACCEPTED, not refused — the tools no longer disagree', () => {
    // Reported as the two tools disagreeing: backend_chat could create a
    // composite constraint while apply_migration refused it.
    expect(() =>
      parseMigration('ALTER TABLE conversations ADD CONSTRAINT c CHECK (user_a < user_b)', {
        tableExists: () => true,
        columnsOf: () => ['user_a', 'user_b'],
      } as any),
    ).not.toThrow()
  })

  it('multi-column UNIQUE is ACCEPTED', () => {
    expect(() =>
      parseMigration('ALTER TABLE conversations ADD CONSTRAINT u UNIQUE (user_a, user_b)', {
        tableExists: () => true,
        columnsOf: () => ['user_a', 'user_b'],
      } as any),
    ).not.toThrow()
  })

  it('text[] is ACCEPTED', () => {
    expect(() =>
      parseMigration('CREATE TABLE t (tags text[])', { tableExists: () => false, columnsOf: () => [] } as any),
    ).not.toThrow()
  })
})
