/**
 * The migration parser is the write door for every MCP agent, so its failure
 * modes matter more than its happy path. Two classes are tested hardest:
 *
 *   1. Silent mis-parse — a statement that produces the WRONG action is far
 *      worse than one that is refused, because the agent believes it worked.
 *   2. Dead-end refusal — every refusal must carry a hint naming the way
 *      forward, since a refusal an agent cannot recover from in one turn is
 *      the exact failure this whole surface exists to remove.
 */

import {
  parseMigration,
  splitStatements,
  MigrationParseError,
} from '@/lib/mcp/migration-parser'

function parseOne(sql: string) {
  const actions = parseMigration(sql)
  expect(actions).toHaveLength(1)
  return actions[0]
}

function expectRefusal(sql: string): MigrationParseError {
  try {
    parseMigration(sql)
  } catch (err) {
    expect(err).toBeInstanceOf(MigrationParseError)
    return err as MigrationParseError
  }
  throw new Error(`Expected a refusal for: ${sql}`)
}

describe('splitStatements', () => {
  it('splits on real terminators', () => {
    expect(splitStatements('CREATE TABLE a (x text); CREATE TABLE b (y text);')).toHaveLength(2)
  })

  it('does not split inside a string literal', () => {
    const out = splitStatements(`ALTER TABLE t ADD COLUMN s text DEFAULT 'a;b'`)
    expect(out).toHaveLength(1)
  })

  it('does not split inside a quoted identifier', () => {
    const out = splitStatements(`CREATE TABLE "we;ird" (x text)`)
    expect(out).toHaveLength(1)
  })

  it('strips comments without losing the statement', () => {
    const out = splitStatements('-- add posts\nCREATE TABLE posts (title text); /* done */')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/CREATE TABLE posts/)
  })

  it('does not split inside a dollar-quoted body', () => {
    const out = splitStatements(`CREATE TABLE t (x text); SELECT $$a;b$$`)
    expect(out).toHaveLength(2)
  })
})

describe('CREATE TABLE', () => {
  it('maps columns and types', () => {
    const a = parseOne('CREATE TABLE posts (title text NOT NULL, views integer)')
    expect(a.tool).toBe('create_table')
    expect(a.args.tableName).toBe('posts')
    expect(a.args.columns).toEqual([
      { name: 'title', type: 'text', nullable: false },
      { name: 'views', type: 'int', nullable: true },
    ])
  })

  it('keeps precision types intact rather than splitting on their comma', () => {
    const a = parseOne('CREATE TABLE items (price numeric(10,2), label varchar(255))')
    expect(a.args.columns).toEqual([
      { name: 'price', type: 'numeric', nullable: true },
      { name: 'label', type: 'text', nullable: true },
    ])
  })

  it('handles multi-word types', () => {
    const a = parseOne('CREATE TABLE m (at timestamp with time zone, ratio double precision)')
    expect(a.args.columns).toEqual([
      { name: 'at', type: 'timestamp', nullable: true },
      { name: 'ratio', type: 'numeric', nullable: true },
    ])
  })

  it('skips platform-managed columns and reports which', () => {
    const a = parseOne(
      'CREATE TABLE posts (id uuid PRIMARY KEY, title text, created_at timestamptz, updated_at timestamptz)',
    )
    expect(a.args.columns).toEqual([{ name: 'title', type: 'text', nullable: true }])
    expect(a.notes?.join(' ')).toMatch(/id, created_at, updated_at/)
    // The note must NOT leak into args — dispatchTool forwards args straight to
    // the executor, and an unknown key there is a silent contract violation.
    expect(Object.keys(a.args).sort()).toEqual(['columns', 'tableName'])
  })

  it('reads an inline REFERENCES as a foreign key', () => {
    const a = parseOne('CREATE TABLE posts (author_id uuid REFERENCES users(id), title text)')
    expect((a.args.columns as any[])[0]).toEqual({ name: 'author_id', type: 'uuid', fkTo: 'users', nullable: true })
  })

  it('folds a table-level FOREIGN KEY onto its column', () => {
    const a = parseOne(
      'CREATE TABLE posts (author_id uuid, title text, FOREIGN KEY (author_id) REFERENCES users(id))',
    )
    expect((a.args.columns as any[])[0]).toEqual({ name: 'author_id', type: 'uuid', fkTo: 'users', nullable: true })
  })

  it('folds a table-level UNIQUE onto its column', () => {
    const a = parseOne('CREATE TABLE u (email text, UNIQUE (email))')
    expect((a.args.columns as any[])[0].unique).toBe(true)
  })

  // Agents format DDL across lines far more often than not. The parser uses
  // [\s\S] rather than `.` with the /s flag because the build targets below
  // es2018, so this asserts the substitution actually preserved the behaviour.
  it('parses a statement written across multiple lines', () => {
    const a = parseOne(`CREATE TABLE posts (
        title   text NOT NULL,
        body    text,
        author_id uuid REFERENCES users(id)
      )`)
    expect(a.args.tableName).toBe('posts')
    expect(a.args.columns).toEqual([
      { name: 'title', type: 'text', nullable: false },
      { name: 'body', type: 'text', nullable: true },
      { name: 'author_id', type: 'uuid', fkTo: 'users', nullable: true },
    ])
  })

  it('parses a multi-line ALTER TABLE', () => {
    const a = parseOne(`ALTER TABLE posts
        ADD COLUMN likes integer DEFAULT 0`)
    expect(a.tool).toBe('add_column')
    expect(a.args).toMatchObject({ tableName: 'posts', column: { name: 'likes', type: 'int' } })
  })

  it('accepts IF NOT EXISTS and quoted identifiers', () => {
    const a = parseOne('CREATE TABLE IF NOT EXISTS "Posts" ("Title" text)')
    expect(a.args.tableName).toBe('Posts')
    expect((a.args.columns as any[])[0].name).toBe('Title')
  })

  it('refuses a table with only managed columns instead of creating an empty one', () => {
    const err = expectRefusal('CREATE TABLE empty (id uuid PRIMARY KEY)')
    expect(err.code).toBe('NO_COLUMNS')
    expect(err.hint).toBeTruthy()
  })
})

describe('ALTER TABLE', () => {
  it('translates ADD COLUMN', () => {
    const a = parseOne('ALTER TABLE posts ADD COLUMN likes integer DEFAULT 0')
    expect(a.tool).toBe('add_column')
    expect(a.args).toMatchObject({
      tableName: 'posts',
      column: { name: 'likes', type: 'int', default: '0' },
    })
  })

  it('accepts ADD without the COLUMN keyword', () => {
    const a = parseOne('ALTER TABLE posts ADD published boolean NOT NULL')
    expect(a.tool).toBe('add_column')
    expect((a.args.column as any).nullable).toBe(false)
  })

  // The dispatch contract is {tableName, oldName, newName} (lib/ai/brain/tools.ts).
  // Emitting {from, to} would type-check and read fine while doing nothing.
  it('translates RENAME COLUMN into the exact dispatch contract', () => {
    const a = parseOne('ALTER TABLE posts RENAME COLUMN body TO content')
    expect(a.tool).toBe('rename_column')
    expect(a.args).toEqual({ tableName: 'posts', oldName: 'body', newName: 'content' })
  })

  it('translates a single-column CHECK into a column-scoped constraint', () => {
    const a = parseOne('ALTER TABLE posts ADD CONSTRAINT title_len CHECK (length(title) > 0)')
    expect(a.tool).toBe('add_constraint')
    expect(a.args).toEqual({
      tableName: 'posts',
      columnName: 'title',
      columns: ['title'],
      constraintType: 'check',
      expression: 'length(title) > 0',
      // The author's name is carried through. It used to be dropped in favour of
      // `chk_<table>_<column>`, which collides with every other constraint on
      // the same column — the root of the false "already exists" (defect #2).
      constraintName: 'title_len',
    })
  })

  it('does not count string literals as columns in a CHECK', () => {
    const a = parseOne(`ALTER TABLE posts ADD CONSTRAINT s CHECK (status IN ('draft','live'))`)
    expect(a.args).toMatchObject({ columnName: 'status', constraintType: 'check' })
  })

  // A CHECK over two columns is not ambiguous — in SQL it is a table-level
  // constraint. Refusing it as AMBIGUOUS_CONSTRAINT made every cross-column
  // invariant inexpressible: date ordering, no-self-reference on a join table,
  // `user_a < user_b` canonical ordering. Reported as defect #11.
  it('applies a CHECK spanning several columns as a table-level constraint', () => {
    const a = parseOne('ALTER TABLE t ADD CONSTRAINT d CHECK (start_date < end_date)')
    expect(a.tool).toBe('add_constraint')
    expect(a.args).toEqual({
      tableName: 't',
      columns: ['start_date', 'end_date'],
      constraintType: 'check',
      expression: 'start_date < end_date',
      constraintName: 'd',
    })
    // No columnName — the constraint belongs to the table, not one column.
    expect(a.args).not.toHaveProperty('columnName')
  })

  it('applies a no-self-reference CHECK on a two-party join table', () => {
    const a = parseOne('ALTER TABLE connections ADD CONSTRAINT no_self CHECK (requester_id <> addressee_id)')
    expect(a.args).toMatchObject({
      tableName: 'connections',
      columns: ['requester_id', 'addressee_id'],
      constraintType: 'check',
    })
  })

  it('translates UNIQUE and FOREIGN KEY constraints', () => {
    expect(parseOne('ALTER TABLE u ADD CONSTRAINT ue UNIQUE (email)').args).toEqual({
      tableName: 'u', columnName: 'email', constraintType: 'unique', constraintName: 'ue',
    })
    expect(parseOne('ALTER TABLE p ADD FOREIGN KEY (author_id) REFERENCES users(id)').args).toEqual({
      tableName: 'p',
      columnName: 'author_id',
      constraintType: 'foreign_key',
      expression: 'users(id)',
      referencedTable: 'users',
    })
  })

  // Defect #10: this was refused, and its own hint pointed at CREATE UNIQUE
  // INDEX — which then silently dropped both the composite-ness and the
  // uniqueness (defects #5 and #4). Three bugs in one dead end.
  it('applies a multi-column UNIQUE as a composite unique index', () => {
    const a = parseOne('ALTER TABLE conversations ADD CONSTRAINT pair UNIQUE (user_a, user_b)')
    expect(a.tool).toBe('create_index')
    expect(a.args).toEqual({
      tableName: 'conversations',
      columns: ['user_a', 'user_b'],
      unique: true,
      indexName: 'pair',
    })
    expect(a.notes?.join(' ')).toMatch(/unique index/i)
  })

  it('translates ALTER COLUMN DROP NOT NULL and DEFAULT changes', () => {
    expect(parseOne('ALTER TABLE posts ALTER COLUMN title DROP NOT NULL').args).toEqual({
      tableName: 'posts', columnName: 'title', constraintType: 'drop_not_null',
    })
    expect(parseOne("ALTER TABLE posts ALTER COLUMN status SET DEFAULT 'draft'").args).toEqual({
      tableName: 'posts', columnName: 'status', constraintType: 'set_default', expression: "'draft'",
    })
    expect(parseOne('ALTER TABLE posts ALTER COLUMN status DROP DEFAULT').args).toEqual({
      tableName: 'posts', columnName: 'status', constraintType: 'drop_default',
    })
  })

  it('translates ALTER COLUMN SET NOT NULL', () => {
    expect(parseOne('ALTER TABLE posts ALTER COLUMN title SET NOT NULL').args).toEqual({
      tableName: 'posts', columnName: 'title', constraintType: 'not_null',
    })
  })

  it('refuses adding a primary key, explaining the managed id', () => {
    const err = expectRefusal('ALTER TABLE t ADD CONSTRAINT pk PRIMARY KEY (code)')
    expect(err.code).toBe('UNSUPPORTED_CONSTRAINT')
    expect(err.hint).toMatch(/managed `id`|UNIQUE/)
  })

  it('refuses DROP COLUMN as destructive, naming the approval path', () => {
    const err = expectRefusal('ALTER TABLE posts DROP COLUMN body')
    expect(err.code).toBe('DESTRUCTIVE_REFUSED')
    expect(err.hint).toMatch(/backend_chat/)
  })

  it('refuses an unmodelled ALTER action with a route forward', () => {
    const err = expectRefusal('ALTER TABLE posts ALTER COLUMN title TYPE integer')
    expect(err.code).toBe('UNSUPPORTED_STATEMENT')
    expect(err.hint).toMatch(/backend_chat/)
  })
})

describe('CREATE INDEX', () => {
  // create_index's contract is {tableName, columns, unique} — no index name.
  // Defect #4: `unique` was declared here but dropped by the dispatch mapper, so
  // a UNIQUE index arrived non-unique and nothing prevented duplicate rows. The
  // response mentioned only the renamed index — the one harmless difference.
  it('keeps UNIQUE and honours the caller-supplied index name', () => {
    const a = parseOne('CREATE UNIQUE INDEX idx_email ON users (email)')
    expect(a.tool).toBe('create_index')
    expect(a.args).toEqual({
      tableName: 'users', columns: ['email'], unique: true, indexName: 'idx_email',
    })
    expect(a.notes).toBeUndefined()
  })

  // Defect #5: two columns became one, silently.
  it('keeps every column of a composite unique index', () => {
    const a = parseOne('CREATE UNIQUE INDEX idx_pair ON conversations (user_a, user_b)')
    expect(a.args).toEqual({
      tableName: 'conversations',
      columns: ['user_a', 'user_b'],
      unique: true,
      indexName: 'idx_pair',
    })
  })

  it('carries an index method through instead of dropping it', () => {
    expect(parseOne('CREATE INDEX ON posts USING gin (tags)').args).toEqual({
      tableName: 'posts', columns: ['tags'], unique: false, method: 'gin',
    })
  })

  it('carries a partial index predicate through instead of dropping it', () => {
    const a = parseOne('CREATE INDEX ON posts (author_id) WHERE deleted_at IS NULL')
    expect(a.args).toMatchObject({
      tableName: 'posts', columns: ['author_id'], where: 'deleted_at IS NULL',
    })
  })

  it('refuses an index clause it cannot translate rather than ignoring it', () => {
    const err = expectRefusal('CREATE INDEX ON posts (author_id) INCLUDE (title)')
    expect(err.code).toBe('UNSUPPORTED_STATEMENT')
    expect(err.hint).toBeTruthy()
  })

  it('translates an unnamed multi-column index and strips sort modifiers', () => {
    const a = parseOne('CREATE INDEX ON posts (author_id, created_at DESC)')
    expect(a.args).toEqual({
      tableName: 'posts', columns: ['author_id', 'created_at'], unique: false,
    })
    expect(a.notes).toBeUndefined()
  })
})

describe('refusals route somewhere', () => {
  it('sends SELECT to run_query', () => {
    const err = expectRefusal('SELECT * FROM posts')
    expect(err.code).toBe('READ_NOT_MIGRATION')
    expect(err.hint).toMatch(/run_query/)
  })

  it('sends INSERT to the typed data tools', () => {
    const err = expectRefusal("INSERT INTO posts (title) VALUES ('x')")
    expect(err.code).toBe('DML_NOT_MIGRATION')
    expect(err.hint).toMatch(/db_insert/)
  })

  it('sends UPDATE and DELETE to the typed data tools', () => {
    expect(expectRefusal("UPDATE posts SET title = 'x'").hint).toMatch(/db_update/)
    expect(expectRefusal('DELETE FROM posts').hint).toMatch(/db_delete/)
  })

  it('refuses DROP TABLE via the approval path', () => {
    const err = expectRefusal('DROP TABLE posts')
    expect(err.code).toBe('DESTRUCTIVE_REFUSED')
    expect(err.hint).toMatch(/Review Queue/)
  })

  it('refuses an unsupported type but lists the supported ones', () => {
    const err = expectRefusal('CREATE TABLE t (shape geometry)')
    expect(err.code).toBe('UNSUPPORTED_TYPE')
    expect(err.hint).toMatch(/backend_chat/)
  })

  it('refuses an unsupported ARRAY element type by naming the element', () => {
    const err = expectRefusal('CREATE TABLE t (shapes geometry[])')
    expect(err.code).toBe('UNSUPPORTED_TYPE')
    expect(err.message).toMatch(/geometry/)
  })

  it('refuses a schema-qualified name and shows the bare form', () => {
    const err = expectRefusal('CREATE TABLE workspace_x.posts (title text)')
    expect(err.code).toBe('QUALIFIED_NAME')
    expect(err.hint).toMatch(/bare table name/)
  })

  it('never refuses without a hint', () => {
    for (const sql of [
      'DROP TABLE posts',
      'SELECT 1',
      "INSERT INTO t (a) VALUES (1)",
      'ALTER TABLE t ALTER COLUMN c TYPE int',
      'CREATE TABLE t (x geometry)',
      'VACUUM',
    ]) {
      expect(expectRefusal(sql).hint).toBeTruthy()
    }
  })
})

/**
 * The guard that matters most.
 *
 * Every other test asserts the parser against shapes written by hand in this
 * file — which is how the first version shipped `{from, to}` for rename_column
 * while the executor wanted `{oldName, newName}`. Every test passed; the tool
 * would have silently done nothing. This suite asserts against the SOURCE OF
 * TRUTH instead, so the two can never drift again.
 */
describe('conformance with the real dispatch contract', () => {
  const SAMPLES = [
    'CREATE TABLE posts (title text NOT NULL, author_id uuid REFERENCES users(id))',
    'ALTER TABLE posts ADD COLUMN likes integer DEFAULT 0',
    'ALTER TABLE posts RENAME COLUMN body TO content',
    'ALTER TABLE posts ADD CONSTRAINT t CHECK (length(title) > 0)',
    'ALTER TABLE u ADD CONSTRAINT ue UNIQUE (email)',
    'ALTER TABLE p ADD FOREIGN KEY (author_id) REFERENCES users(id)',
    'ALTER TABLE posts ALTER COLUMN title SET NOT NULL',
    'CREATE UNIQUE INDEX idx_email ON users (email)',
    'CREATE INDEX ON posts (author_id, created_at DESC)',
  ]

  // Loaded lazily so a failure to import surfaces as a test failure, not a
  // suite-level crash that reads like the parser is fine.
  const schemas = (() => {
    const { BRAIN_TOOLS } = require('@/lib/ai/brain/tools')
    const map = new Map<string, { props: Set<string>; required: string[] }>()
    for (const t of BRAIN_TOOLS) {
      const f = t.function
      if (!f?.name) continue
      const p = (f.parameters ?? {}) as any
      map.set(f.name, {
        props: new Set(Object.keys(p.properties ?? {})),
        required: p.required ?? [],
      })
    }
    return map
  })()

  it.each(SAMPLES)('emits a tool that exists: %s', (sql) => {
    for (const action of parseMigration(sql)) {
      expect(schemas.has(action.tool)).toBe(true)
    }
  })

  it.each(SAMPLES)('emits only declared arg keys: %s', (sql) => {
    for (const action of parseMigration(sql)) {
      const schema = schemas.get(action.tool)!
      const undeclared = Object.keys(action.args).filter((k) => !schema.props.has(k))
      expect({ tool: action.tool, undeclared }).toEqual({ tool: action.tool, undeclared: [] })
    }
  })

  it.each(SAMPLES)('supplies every required arg: %s', (sql) => {
    for (const action of parseMigration(sql)) {
      const schema = schemas.get(action.tool)!
      const missing = schema.required.filter((k) => action.args[k] === undefined)
      expect({ tool: action.tool, missing }).toEqual({ tool: action.tool, missing: [] })
    }
  })

  it('only ever emits constraintType values the enum accepts', () => {
    const allowed = new Set(['not_null', 'unique', 'check', 'foreign_key'])
    for (const sql of SAMPLES) {
      for (const a of parseMigration(sql)) {
        if (a.tool !== 'add_constraint') continue
        expect(allowed.has(String(a.args.constraintType))).toBe(true)
      }
    }
  })
})

describe('multi-statement migrations', () => {
  it('translates each statement in order', () => {
    const actions = parseMigration(`
      CREATE TABLE authors (name text NOT NULL);
      CREATE TABLE posts (title text, author_id uuid REFERENCES authors(id));
      CREATE INDEX ON posts (author_id);
    `)
    expect(actions.map((a) => a.tool)).toEqual(['create_table', 'create_table', 'create_index'])
  })

  it('refuses the WHOLE migration when any statement is unsupported', () => {
    const err = expectRefusal(`
      CREATE TABLE ok (x text);
      DROP TABLE something;
    `)
    expect(err.code).toBe('DESTRUCTIVE_REFUSED')
  })
})

/**
 * ── The DDL an agent writes is the DDL that gets created ────────────────────
 *
 * `apply_migration` used to report "✅ Applied 6 statement(s)" with no warnings
 * while silently rewriting what it had been given:
 *
 *   declared                                  created
 *   ────────────────────────────────────────  ───────────────────────────────
 *   active boolean NOT NULL DEFAULT true      nullable, DEFAULT false
 *   stock integer NOT NULL DEFAULT 0          NOT NULL, no default
 *   description text            (nullable)    NOT NULL
 *   status text NOT NULL DEFAULT 'pending'    DEFAULT 'active'
 *
 * Two causes, both here and both about information the parser HAD and dropped:
 *
 *   1. `DEFAULT ...` was parsed into `col.default` and nothing downstream ever
 *      read it, so name-based inference supplied its own value instead.
 *   2. Absence of NOT NULL left `nullable` undefined, so inference decided —
 *      and its rule (`isRequired = !name.includes('optional')`) makes almost
 *      everything NOT NULL. In SQL, absence of NOT NULL IS the declaration.
 *
 * A default flipping true→false on an `active` flag hides a whole catalogue.
 * These assert the declaration survives the round trip.
 */
describe('declared DDL survives translation', () => {
  it('treats absence of NOT NULL as an explicit nullable declaration', () => {
    const a = parseOne('CREATE TABLE products (description text, image_url text)')
    expect(a.args.columns).toEqual([
      { name: 'description', type: 'text', nullable: true },
      { name: 'image_url', type: 'text', nullable: true },
    ])
  })

  it('does not claim nullability for a PRIMARY KEY, which implies NOT NULL', () => {
    const a = parseOne('CREATE TABLE t (code text PRIMARY KEY, label text)')
    const code = (a.args.columns as any[]).find(c => c.name === 'code')
    expect(code.nullable).toBe(false)
  })

  it('carries a declared DEFAULT through to the executor', () => {
    const a = parseOne(
      `CREATE TABLE products (
         active  boolean NOT NULL DEFAULT true,
         stock   integer NOT NULL DEFAULT 0,
         status  text    NOT NULL DEFAULT 'pending'
       )`,
    )
    expect(a.args.columns).toEqual([
      { name: 'active', type: 'boolean', nullable: false, default: 'true' },
      { name: 'stock', type: 'int', nullable: false, default: '0' },
      { name: 'status', type: 'text', nullable: false, default: "'pending'" },
    ])
  })

  it('keeps NOT NULL and DEFAULT together — they are not alternatives', () => {
    // `NOT NULL DEFAULT x` is the most common column shape in SQL. The executor
    // used to suppress NOT NULL whenever any default was present.
    const a = parseOne('CREATE TABLE t (n integer NOT NULL DEFAULT 0)')
    const col = (a.args.columns as any[])[0]
    expect(col.nullable).toBe(false)
    expect(col.default).toBe('0')
  })

  it('carries a DEFAULT on ADD COLUMN too', () => {
    const a = parseOne("ALTER TABLE posts ADD COLUMN state text NOT NULL DEFAULT 'draft'")
    expect(a.tool).toBe('add_column')
    expect((a.args.column as any).default).toBe("'draft'")
    expect((a.args.column as any).nullable).toBe(false)
  })
})

/**
 * ── The silent-loss suite ───────────────────────────────────────────────────
 *
 * Every case here was reported from a real MCP session as an operation that
 * returned ✅ while the database disagreed. That is the worst class of defect
 * this surface can have — a refusal costs an agent one turn, but a false success
 * costs it the assumption that its schema is what it wrote. Each test names the
 * defect number it locks down.
 */
describe('silent loss — nothing declared may vanish without a refusal', () => {
  it('#1 extracts an inline column CHECK instead of dropping it', () => {
    const actions = parseMigration(
      `CREATE TABLE connections (
         requester_id uuid NOT NULL REFERENCES users(id),
         addressee_id uuid NOT NULL REFERENCES users(id),
         status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined'))
       )`,
    )
    expect(actions.map((a) => a.tool)).toEqual(['create_table', 'add_constraint'])

    // The column itself keeps its declared shape — the CHECK is lifted out, not
    // traded against the DEFAULT or the nullability.
    const status = (actions[0].args.columns as any[]).find((c) => c.name === 'status')
    expect(status).toEqual({ name: 'status', type: 'text', nullable: false, default: "'pending'" })

    expect(actions[1].args).toMatchObject({
      tableName: 'connections',
      columnName: 'status',
      constraintType: 'check',
      expression: "status IN ('pending','accepted','declined')",
    })
  })

  it('#1 extracts a table-level named CHECK instead of dropping it', () => {
    const actions = parseMigration(
      `CREATE TABLE connections (
         requester_id uuid NOT NULL,
         addressee_id uuid NOT NULL,
         CONSTRAINT connections_no_self CHECK (requester_id <> addressee_id)
       )`,
    )
    expect(actions).toHaveLength(2)
    expect(actions[1].args).toMatchObject({
      constraintType: 'check',
      expression: 'requester_id <> addressee_id',
      constraintName: 'connections_no_self',
      columns: ['requester_id', 'addressee_id'],
    })
  })

  it('#1 handles several CHECKs in one CREATE TABLE, in declaration order', () => {
    const actions = parseMigration(
      `CREATE TABLE events (
         name text NOT NULL CHECK (length(name) > 0),
         starts_at timestamptz NOT NULL,
         ends_at timestamptz NOT NULL,
         seats integer NOT NULL CHECK (seats > 0),
         CONSTRAINT date_order CHECK (starts_at < ends_at)
       )`,
    )
    expect(actions.map((a) => a.tool)).toEqual([
      'create_table', 'add_constraint', 'add_constraint', 'add_constraint',
    ])
    expect(actions.slice(1).map((a) => a.args.expression)).toEqual([
      'length(name) > 0', 'seats > 0', 'starts_at < ends_at',
    ])
  })

  it('#1 extracts an inline CHECK on ADD COLUMN', () => {
    const actions = parseMigration(
      "ALTER TABLE posts ADD COLUMN state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','live'))",
    )
    expect(actions.map((a) => a.tool)).toEqual(['add_column', 'add_constraint'])
    expect((actions[0].args.column as any).default).toBe("'draft'")
    expect(actions[1].args.expression).toBe("state IN ('draft','live')")
  })

  it('#1 refuses a table-level constraint form it cannot translate', () => {
    // The path that used to swallow constraints: parseColumnDef returned null for
    // anything matching TABLE_CONSTRAINT and the caller simply `continue`d.
    const err = expectRefusal(
      'CREATE TABLE t (a int, EXCLUDE USING gist (a WITH &&))',
    )
    expect(err.code).toBe('UNSUPPORTED_CONSTRAINT')
    expect(err.hint).toBeTruthy()
  })

  it('#9 accepts array columns in both spellings', () => {
    expect((parseOne('CREATE TABLE t (tags text[])').args.columns as any[])[0])
      .toMatchObject({ name: 'tags', type: 'text[]' })
    expect((parseOne('CREATE TABLE t (scores integer[])').args.columns as any[])[0])
      .toMatchObject({ type: 'int[]' })
    expect((parseOne('CREATE TABLE t (ids uuid ARRAY)').args.columns as any[])[0])
      .toMatchObject({ type: 'uuid[]' })
    expect((parseOne('CREATE TABLE t (tags varchar(64)[])').args.columns as any[])[0])
      .toMatchObject({ type: 'text[]' })
  })

  it('#9 an array column still honours NOT NULL and DEFAULT', () => {
    const col = (parseOne("CREATE TABLE t (tags text[] NOT NULL DEFAULT '{}')").args.columns as any[])[0]
    expect(col).toMatchObject({ name: 'tags', type: 'text[]', nullable: false })
  })

  it('does not mistake a CHECK keyword inside a string literal for a constraint', () => {
    const actions = parseMigration(
      `CREATE TABLE t (note text NOT NULL DEFAULT 'needs check (soon)')`,
    )
    expect(actions).toHaveLength(1)
    expect((actions[0].args.columns as any[])[0].default).toBe("'needs check (soon)'")
  })

  it('refuses CREATE POLICY by naming add_rls rather than shrugging', () => {
    const err = expectRefusal('CREATE POLICY p ON messages FOR SELECT USING (true)')
    expect(err.code).toBe('RLS_NOT_MIGRATION')
    expect(err.hint).toMatch(/add_rls/)
  })

  it('refuses CREATE TYPE by pointing at the CHECK it should be', () => {
    const err = expectRefusal("CREATE TYPE status AS ENUM ('a','b')")
    expect(err.code).toBe('UNSUPPORTED_STATEMENT')
    expect(err.hint).toMatch(/CHECK/)
  })
})

describe('CHECK expressions cannot smuggle SQL into DDL', () => {
  const unsafe = [
    'ALTER TABLE t ADD CONSTRAINT c CHECK (1=1); DROP TABLE users; --',
    'ALTER TABLE t ADD CONSTRAINT c CHECK (a > (SELECT count(*) FROM users))',
    "ALTER TABLE t ADD CONSTRAINT c CHECK (pg_sleep(10) IS NULL)",
    "ALTER TABLE t ADD CONSTRAINT c CHECK (a = pg_read_file('/etc/passwd'))",
    'ALTER TABLE t ADD CONSTRAINT c CHECK ($$x$$ = a)',
    'ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0) /* comment */ AND',
  ]

  for (const sql of unsafe) {
    it(`refuses: ${sql.slice(30, 80)}`, () => {
      const err = expectRefusal(sql)
      expect(['UNSAFE_CONSTRAINT', 'BAD_STATEMENT', 'UNSUPPORTED_CONSTRAINT', 'UNSUPPORTED_STATEMENT'])
        .toContain(err.code)
      expect(err.hint).toBeTruthy()
    })
  }

  it('still accepts the ordinary predicates a schema actually needs', () => {
    for (const expr of [
      'price > 0',
      "status IN ('a','b','c')",
      'length(title) BETWEEN 1 AND 200',
      'starts_at < ends_at',
      'requester_id <> addressee_id',
      'lower(email) = email',
      'rating >= 1 AND rating <= 5',
      'cardinality(tags) <= 10',
      'discount IS NULL OR discount < total',
    ]) {
      const a = parseOne(`ALTER TABLE t ADD CONSTRAINT c CHECK (${expr})`)
      expect(a.args.expression).toBe(expr)
    }
  })

  it('rejects a CHECK that constrains nothing', () => {
    const err = expectRefusal('ALTER TABLE t ADD CONSTRAINT c CHECK (1 = 1)')
    expect(err.code).toBe('UNSAFE_CONSTRAINT')
  })
})
