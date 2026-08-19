/**
 * Golden workflows + regression guards for the MCP reliability harness.
 *
 * Two kinds of case live here:
 *
 *   guard:  reproduces a defect found in the 2026-07-19 post-mortem. Each one
 *           MUST fail against the pre-fix build and pass after. A guard that
 *           has never been seen red is not trusted — same rule the program
 *           applies to autonomy probes.
 *
 *   target: encodes a standard the platform does NOT meet yet (Phase 1). These
 *           are expected to fail today. A harness that only asserts current
 *           behaviour cannot tell you when you have improved.
 */

import { HarnessClient, isBlindError } from './client.js'

export interface Ctx {
  c: HarnessClient
  /** Namespaced table name, unique per run. */
  t: (name: string) => string
  /**
   * A REAL end-user, signed up through the runtime API at start-up.
   *
   * Seeds must reference a real `users` row: `user_id` columns get a foreign
   * key to users, so a made-up uuid fails with 23503. An earlier version of
   * this harness used a literal 1111… uuid and passed only because the project
   * had no users table yet — i.e. it was green for the wrong reason.
   */
  user: { id: string; token: string }
  /** sk_live runtime key, for the §4 runtime-API contract. */
  runtimeKey: string
}

export interface Case {
  id: string
  title: string
  kind: 'guard' | 'target' | 'golden'
  /** Defect this guards against, for the report. */
  guards?: string
  /** Documented reason this cannot be covered at the HTTP layer. */
  skip?: string
  run(ctx: Ctx): Promise<void>
}

// ── assertions ────────────────────────────────────────────────────────────────

function fail(msg: string): never {
  throw new Error(msg)
}
function expectOk(r: { ok: boolean; error?: string }, what: string) {
  if (!r.ok) fail(`${what} failed: ${r.error ?? 'unknown error'}`)
}
function expectType(
  cols: Map<string, { type: string; nullable: boolean }>,
  col: string,
  match: RegExp,
) {
  const got = cols.get(col)
  if (!got) fail(`column "${col}" missing from the created table`)
  if (!match.test(got.type)) {
    fail(`column "${col}" is ${got.type}, expected ${match}`)
  }
}

// ── cases ─────────────────────────────────────────────────────────────────────

export const CASES: Case[] = [
  {
    id: 'R6-substring-type-hijack',
    kind: 'guard',
    guards: "'start_date'.includes('star') → column created as INTEGER (live since May)",
    title: 'declared timestamp survives name-based heuristics',
    async run({ c, t }) {
      const table = t('sub_hijack')
      expectOk(await c.tool('create_table', {
        tableName: table,
        columns: [
          { name: 'user_id', type: 'uuid' },
          { name: 'start_date', type: 'timestamp' },
          { name: 'start_time', type: 'timestamp' },
          { name: 'started_at', type: 'timestamp' },
          { name: 'restart_count', type: 'int' },
          { name: 'rating', type: 'int' },
        ],
      }), 'create_table')

      const cols = await c.columnTypes(table)
      for (const col of ['start_date', 'start_time', 'started_at']) {
        expectType(cols, col, /timestamp/i)
      }
      expectType(cols, 'restart_count', /integer|bigint/i)
      expectType(cols, 'rating', /integer|bigint/i)
    },
  },

  {
    id: 'R6-external-id-not-uuid',
    kind: 'guard',
    guards: 'third-party id columns coerced to UUID, making them unwritable',
    title: 'external identifier columns keep their declared text type',
    async run({ c, t, user }) {
      const table = t('ext_id')
      expectOk(await c.tool('create_table', {
        tableName: table,
        columns: [
          { name: 'user_id', type: 'uuid' },
          { name: 'stripe_customer_id', type: 'text' },
          { name: 'google_user_id', type: 'text' },
        ],
      }), 'create_table')

      const cols = await c.columnTypes(table)
      expectType(cols, 'stripe_customer_id', /text|character/i)
      expectType(cols, 'google_user_id', /text|character/i)

      // The point of keeping them TEXT: opaque provider strings must insert.
      expectOk(await c.dbInsert(table, {
        user_id: user.id,
        stripe_customer_id: 'cus_Nx9aBcDeFgHiJk',
        google_user_id: '104729382910293812',
      }), 'insert opaque provider ids')
    },
  },

  {
    id: 'R3-explicit-column-flags',
    kind: 'guard',
    guards: 'create_table discarded nullable / unique / fkTo and re-guessed from names',
    title: 'explicit nullable and fkTo are honoured',
    async run({ c, t }) {
      const parent = t('categories')
      expectOk(await c.tool('create_table', {
        tableName: parent,
        columns: [{ name: 'user_id', type: 'uuid' }, { name: 'name', type: 'text' }],
      }), 'create parent table')

      const child = t('budgets')
      expectOk(await c.tool('create_table', {
        tableName: child,
        columns: [
          { name: 'user_id', type: 'uuid' },
          // Irregular plural: convention repair looks for "categorys" and misses.
          { name: 'category_id', type: 'uuid', fkTo: parent },
          { name: 'amount', type: 'numeric' },
          { name: 'note', type: 'text', nullable: true },
        ],
      }), 'create child table')

      const cols = await c.columnTypes(child)
      if (!cols.get('note')?.nullable) fail('column "note" was declared nullable but is NOT NULL')

      const fks = await c.foreignKeys(child)
      const hasFk = fks.some((f: any) =>
        JSON.stringify(f).toLowerCase().includes('category_id'))
      if (!hasFk) fail(`fkTo "${parent}" produced no foreign key on category_id`)
    },
  },

  {
    id: 'R2-timestamp-and-numeric-writes',
    kind: 'guard',
    guards: 'Prisma text-binding + missing casts made every timestamp column unwritable (42804)',
    title: 'timestamps and string-encoded numerics insert in every reasonable spelling',
    async run({ c, t, user }) {
      const table = t('writes')
      expectOk(await c.tool('create_table', {
        tableName: table,
        columns: [
          { name: 'user_id', type: 'uuid' },
          { name: 'occurred_at', type: 'timestamp' },
          { name: 'amount', type: 'numeric' },
          { name: 'qty', type: 'int' },
          { name: 'active', type: 'boolean' },
        ],
      }), 'create_table')

      const uid = user.id
      const spellings: Array<[string, unknown]> = [
        ['ISO with Z',      '2026-07-18T10:00:00Z'],
        ['ISO with offset', '2026-07-18T10:00:00+00:00'],
        ['plain datetime',  '2026-07-18 10:00:00'],
        ['date only',       '2026-07-18'],
      ]
      for (const [label, occurred] of spellings) {
        const r = await c.dbInsert(table, {
          user_id: uid, occurred_at: occurred,
          amount: '84.32',      // string-encoded numeric: what JSON clients send
          qty: '3', active: 'true',
        })
        if (!r.ok) fail(`insert rejected ${label} (${String(occurred)}): ${r.error}`)
      }
    },
  },

  {
    id: 'R2-timestamp-filter',
    kind: 'guard',
    guards: '$gt on a timestamp column hit the same 42804 as inserts',
    title: 'range filters work on timestamp columns',
    async run({ c, t }) {
      const table = t('writes') // reuses the table created above
      const r = await c.dbQuery(table, {
        filter: { occurred_at: { $gt: '2026-01-01T00:00:00Z' } },
      })
      expectOk(r, 'timestamp range query')
      if ((r.data?.count ?? 0) < 1) fail('timestamp range filter returned no rows')
    },
  },

  {
    id: 'R4-api-auto-generated',
    kind: 'guard',
    guards: 'create_table never wrote an ApiDefinition → list_apis reported "no APIs yet"',
    title: 'creating a table exposes its REST API without an explicit generate_api',
    async run({ c, t }) {
      const table = t('autoapi')
      expectOk(await c.tool('create_table', {
        tableName: table,
        columns: [{ name: 'user_id', type: 'uuid' }, { name: 'label', type: 'text' }],
      }), 'create_table')

      const apis = await c.tool('list_apis')
      expectOk(apis, 'list_apis')
      if (!JSON.stringify(apis).includes(table)) {
        fail(`list_apis does not include "${table}" after create_table`)
      }
    },
  },

  {
    id: 'R5-payment-heuristic',
    kind: 'guard',
    guards: "table named 'transactions' demanded a Stripe key",
    title: 'ambiguous table names do not demand a payment provider',
    skip:
      'COVERED ELSEWHERE — tests/unit/payment-heuristic.spec.ts (23 cases). Triggers on ' +
      'an EXACT table name ("transactions"), which this harness cannot use without ' +
      'colliding with a project\'s real tables, so isPaymentTable() is tested directly.',
    async run() { /* skipped */ },
  },

  {
    id: 'GOLDEN-expense-tracker',
    kind: 'golden',
    title: 'build an expense tracker end to end and read it back',
    async run({ c, t, user }) {
      const cats = t('g_categories')
      const accounts = t('g_accounts')
      const txns = t('g_entries')

      expectOk(await c.tool('create_table', {
        tableName: cats,
        columns: [
          { name: 'user_id', type: 'uuid' },
          { name: 'name', type: 'text' },
          { name: 'icon', type: 'text', nullable: true },
        ],
      }), 'create categories')

      expectOk(await c.tool('create_table', {
        tableName: accounts,
        columns: [
          { name: 'user_id', type: 'uuid' },
          { name: 'name', type: 'text' },
          { name: 'balance', type: 'numeric' },
        ],
      }), 'create accounts')

      expectOk(await c.tool('create_table', {
        tableName: txns,
        columns: [
          { name: 'user_id', type: 'uuid' },
          { name: 'account_id', type: 'uuid', fkTo: accounts },
          { name: 'category_id', type: 'uuid', fkTo: cats },
          { name: 'amount', type: 'numeric' },
          { name: 'occurred_at', type: 'timestamp' },
          { name: 'note', type: 'text', nullable: true },
        ],
      }), 'create entries')

      const uid = user.id
      const cat = await c.dbInsert(cats, { user_id: uid, name: 'Groceries' })
      expectOk(cat, 'seed category')
      const acct = await c.dbInsert(accounts, { user_id: uid, name: 'Checking', balance: '2500.00' })
      expectOk(acct, 'seed account')

      const catId = (cat as any).data?.row?.id
      const acctId = (acct as any).data?.row?.id
      if (!catId || !acctId) fail('seed rows did not return ids')

      expectOk(await c.dbInsert(txns, {
        user_id: uid, account_id: acctId, category_id: catId,
        amount: '84.32', occurred_at: '2026-07-18T10:00:00Z', note: 'Weekly run',
      }), 'seed transaction')

      const read = await c.dbQuery(txns, {
        filter: { occurred_at: { $gt: '2026-01-01T00:00:00Z' } },
      })
      expectOk(read, 'read back transactions')
      if ((read.data?.count ?? 0) < 1) fail('expense entry did not read back')
    },
  },

  // ── Doc truthfulness ────────────────────────────────────────────────────────
  // Every factual claim in get_instructions gets an asserting test. Bug #4 hid
  // for months because "every table automatically gets a REST API" was written
  // down, believed by agents, and never checked. A claim without a test is a
  // claim that will eventually become a lie. One case per section of the doc,
  // so a failure points at the exact sentence that stopped being true.

  {
    id: 'CONTRACT-2-build-claims',
    kind: 'guard',
    guards: 'get_instructions promised auto-generated REST APIs that never existed',
    title: '§2 — every table gets a REST API and an own-rows RLS policy',
    async run({ c, t }) {
      const r = await c.tool('get_instructions')
      expectOk(r, 'get_instructions')
      const text = String(r.summary ?? '') + JSON.stringify(r.data ?? {})

      if (/automatically gets a REST API/i.test(text)) {
        const table = t('claim_api')
        expectOk(await c.tool('create_table', {
          tableName: table, columns: [{ name: 'user_id', type: 'uuid' }],
        }), 'create_table for claim check')
        const apis = await c.tool('list_apis')
        if (!JSON.stringify(apis).includes(table)) {
          fail('claims every table gets a REST API; list_apis disagrees')
        }
      }

      if (/own-rows RLS/i.test(text)) {
        const table = t('claim_rls')
        expectOk(await c.tool('create_table', {
          tableName: table,
          columns: [{ name: 'user_id', type: 'uuid' }, { name: 'body', type: 'text' }],
        }), 'create_table for RLS claim')
        const schema = await c.tool('get_table_schema', { tableName: table })
        const policies = (schema.data?.policies ?? []) as any[]
        if (policies.length === 0) {
          fail('claims own-rows RLS is automatic; the table has no policies')
        }
      }
    },
  },

  {
    id: 'CONTRACT-1-named-tools-exist',
    kind: 'guard',
    title: '§1–§6 — every tool named in the instructions actually exists',
    async run({ c }) {
      const r = await c.tool('get_instructions')
      expectOk(r, 'get_instructions')
      const doc = String(r.summary ?? '')

      const manifest = await c.manifest()
      const available = new Set(manifest.tools.map((t) => t.name))
      // Synthetic tools served by the route rather than the brain catalogue.
      for (const synthetic of ['fetch_docs', 'check_approval']) available.add(synthetic)

      // Names the doc tells an agent to call. Matched on the verb_noun tool
      // convention rather than "any backticked word" — the looser pattern
      // scraped `https` out of a URL and `approval` out of prose, so the case
      // failed on its own sloppiness instead of on a real broken promise.
      const named = new Set<string>()
      for (const m of doc.matchAll(
        /\b((?:get|list|create|add|enable|generate|store|set|rotate|revoke|reset|toggle|adopt|connect|send|check|fetch|db)_[a-z_]+|backend_chat)\b/g,
      )) {
        named.add(m[1])
      }
      // Destructive tools are named in §5 precisely to say they are refused.
      for (const d of ['drop_table', 'truncate_table', 'drop_column', 'delete_bucket']) named.delete(d)
      // Illustrative FUNCTION names, not tools. The functions section explains
      // that a user's function name is normalised to kebab-case, and the only
      // way to show that is to write one out: "`list_products` deploys as
      // `list-products`". It matches the verb_noun shape, so the scraper reads
      // it as a tool the agent was told to call. This is the third variant of
      // the same over-broad-match bug (the pattern previously pulled `https`
      // out of a URL and `approval` out of prose), so it is excluded by name
      // rather than by loosening the pattern again.
      for (const example of ['list_products']) named.delete(example)

      const missing = [...named].filter((n) => !available.has(n))
      if (missing.length > 0) {
        fail(`instructions reference tools that do not exist: ${missing.join(', ')}`)
      }
    },
  },

  {
    id: 'CONTRACT-1-metadata-and-schema',
    kind: 'guard',
    title: '§1 — get_backend_metadata alias, and get_table_schema returns every documented field',
    async run({ c, t }) {
      // Claim: get_backend_metadata is an alias of get_project_overview.
      const alias = await c.tool('get_backend_metadata')
      expectOk(alias, 'get_backend_metadata (documented alias)')
      for (const key of ['tables', 'relationships', 'auth', 'storage', 'realtime', 'functions']) {
        if (!(key in (alias.data ?? {}))) {
          fail(`get_backend_metadata is documented to report ${key}; it is absent`)
        }
      }

      // Claim: get_table_schema shows columns (type/nullable/default/PK), foreign
      // keys, indexes, CHECK constraints, triggers and the live RLS policies.
      const table = t('schema_claims')
      expectOk(await c.tool('create_table', {
        tableName: table,
        columns: [
          { name: 'user_id', type: 'uuid' },
          { name: 'label', type: 'text', nullable: true },
        ],
      }), 'create_table for schema claim')

      const s = await c.tool('get_table_schema', { tableName: table })
      expectOk(s, 'get_table_schema')
      for (const key of ['columns', 'foreignKeys', 'indexes', 'checkConstraints', 'triggers', 'policies']) {
        if (!Array.isArray(s.data?.[key])) {
          fail(`get_table_schema is documented to report ${key}; it is missing or not a list`)
        }
      }
      const col = (s.data.columns as any[]).find((x) => x.name === 'user_id')
      for (const field of ['type', 'nullable', 'primaryKey']) {
        if (!(field in (col ?? {}))) fail(`columns are documented to carry ${field}; absent`)
      }
      if (!('default' in (col ?? {}))) fail('columns are documented to carry default; absent')
    },
  },

  {
    id: 'CONTRACT-3-query-operators',
    kind: 'guard',
    title: '§3 — every documented filter operator works',
    async run({ c, t, user }) {
      const table = t('ops')
      expectOk(await c.tool('create_table', {
        tableName: table,
        columns: [
          { name: 'user_id', type: 'uuid' },
          { name: 'name', type: 'text' },
          { name: 'score', type: 'int' },
        ],
      }), 'create_table')

      const uid = user.id
      for (const [name, score] of [['alpha', 10], ['beta', 20], ['gamma', 30]] as const) {
        expectOk(await c.dbInsert(table, { user_id: uid, name, score }), `seed ${name}`)
      }

      // Exactly the operators §3 advertises.
      const checks: Array<[string, Record<string, unknown>, number]> = [
        ['$gt',       { score: { $gt: 20 } }, 1],
        ['$gte',      { score: { $gte: 20 } }, 2],
        ['$lt',       { score: { $lt: 20 } }, 1],
        ['$lte',      { score: { $lte: 20 } }, 2],
        ['$ne',       { score: { $ne: 20 } }, 2],
        ['$in',       { score: { $in: [10, 30] } }, 2],
        ['$contains', { name: { $contains: 'et' } }, 1],
        ['$ilike',    { name: { $ilike: 'ALPHA' } }, 1],
      ]
      for (const [op, filter, expected] of checks) {
        const r = await c.dbQuery(table, { filter })
        if (!r.ok) fail(`documented operator ${op} failed: ${r.error}`)
        if ((r.data?.count ?? -1) !== expected) {
          fail(`documented operator ${op} returned ${r.data?.count} rows, expected ${expected}`)
        }
      }
    },
  },

  {
    id: 'CONTRACT-3-mutation-guardrails',
    kind: 'guard',
    title: '§3 — update/delete refuse an empty filter',
    async run({ c, t }) {
      const table = t('ops') // reuses the seeded table above
      const upd = await c.dbUpdate(table, {}, { name: 'clobbered' })
      if (upd.ok) fail('db_update accepted an empty filter — a table-wide UPDATE is possible')

      const del = await c.dbDelete(table, {})
      if (del.ok) fail('db_delete accepted an empty filter — a table-wide DELETE is possible')

      // The rows must still be intact.
      const after = await c.dbQuery(table, {})
      if ((after.data?.count ?? 0) !== 3) {
        fail(`guardrail leaked: expected 3 rows intact, found ${after.data?.count}`)
      }
    },
  },

  {
    id: 'CONTRACT-5-destructive-refused',
    kind: 'guard',
    title: '§5 — destructive tools are refused over MCP and point at the Review Queue',
    async run({ c, t }) {
      const table = t('ops')
      for (const tool of ['drop_table', 'truncate_table', 'drop_column', 'delete_bucket']) {
        const r = await c.tool(tool, { tableName: table, columnName: 'name', bucketName: 'x' })
        if (r.ok) fail(`${tool} executed over MCP — §5 says it must not`)
        if (r.code !== 'DESTRUCTIVE_NEEDS_APPROVAL') {
          fail(`${tool} refused with code "${r.code}", expected DESTRUCTIVE_NEEDS_APPROVAL`)
        }
        if (!/review queue/i.test(String(r.error))) {
          fail(`${tool} refusal does not mention the Review Queue: ${r.error}`)
        }
      }

      // §5 tells the agent to poll check_approval — it must exist and validate input.
      const probe = await c.tool('check_approval', { id: '00000000-0000-0000-0000-000000000000' })
      if (probe.ok) fail('check_approval reported success for an approval id that cannot exist')
    },
  },

  {
    id: 'CONTRACT-6-ship-tools',
    kind: 'guard',
    title: '§6 — get_readiness and get_deploy_status respond',
    async run({ c }) {
      expectOk(await c.tool('get_readiness', { autoFix: false }), 'get_readiness')
      expectOk(await c.tool('get_deploy_status'), 'get_deploy_status')
    },
  },

  {
    id: 'CONTRACT-4-runtime-api',
    kind: 'guard',
    title: '§4 — the runtime contract published to agents holds end to end',
    async run({ c, t, user, runtimeKey }) {
      const r = await c.tool('get_instructions')
      const apiBase = String(r.data?.apiBase ?? '')
      if (!apiBase.endsWith(`/api/v1/${c.projectId}`)) {
        fail(`documented base URL "${apiBase}" does not match this project`)
      }

      // §4 says calls carry a proj_live_ / proj_test_ runtime key.
      //
      // This asserted sk_live_ until 2026-08-19, which the product had already
      // stopped issuing. get_instructions says so in as many words: "`sk_live_`
      // is the Stripe prefix, NOT the Backenly one -- a Backenly project key
      // always starts `proj_live_` or `proj_test_`". So the harness was failing
      // the runtime contract for matching the documentation. It went stale
      // unnoticed because BACKENLY_MCP_KEY was never set, so this case had
      // never once executed.
      if (!/^proj_(live|test)_/.test(runtimeKey)) {
        fail(`§4 documents a proj_live_/proj_test_ runtime key; got "${runtimeKey.slice(0, 12)}…"`)
      }
      // The token itself was obtained by the bootstrap through POST /auth/signup,
      // which is §4's first claim — reaching this case at all proves it.
      if (!user.token) fail('§4 documents /auth/signup returning a token; none was issued')

      const table = t('rt')
      expectOk(await c.tool('create_table', {
        tableName: table,
        columns: [{ name: 'user_id', type: 'uuid' }, { name: 'body', type: 'text' }],
      }), 'create_table for runtime check')

      // Claim: CRUD lives at GET/POST/PUT/DELETE /db/<table>.
      const list = await c.runtime('GET', `/db/${table}`, runtimeKey)
      if (!list.ok) fail(`§4 documents GET /db/<table>; got HTTP ${list.status}`)

      // Claim: "An API key alone is NOT a user; owner writes without a user token
      // are correctly denied on own-rows tables." Send a well-formed row so the
      // denial has to come from RLS rather than from input validation — otherwise
      // this passes for the wrong reason.
      const noUser = await c.runtime('POST', `/db/${table}`, runtimeKey, {
        body: { user_id: user.id, body: 'no user token' },
      })
      if (noUser.ok) {
        fail('§4 claims a write without X-User-Token is denied on own-rows tables; it succeeded')
      }

      // Claim: X-User-Token authorises the call and RLS scopes rows to that user.
      const asUser = await c.runtime('POST', `/db/${table}`, runtimeKey, {
        body: { user_id: user.id, body: 'written as an end user' },
        userToken: user.token,
      })
      if (!asUser.ok) {
        fail(`§4 claims X-User-Token authorises data calls; got HTTP ${asUser.status}: ${JSON.stringify(asUser.body)?.slice(0, 200)}`)
      }

      // ...and the scoping is real: the same token reads its own row back.
      const scoped = await c.runtime('GET', `/db/${table}`, runtimeKey, { userToken: user.token })
      if (!scoped.ok) fail(`scoped read failed: HTTP ${scoped.status}`)
      const rows = scoped.body?.data ?? scoped.body?.rows ?? []
      if (!Array.isArray(rows) || rows.length < 1) {
        fail('§4 claims RLS scopes rows to the token holder; the user cannot read their own row')
      }
    },
  },

  {
    // Was kind:'target' — the standard Phase 1 was written to meet. Now that the
    // structured error contract has shipped this is a regression guard, so it
    // blocks by default rather than only under --strict.
    id: 'R8-actionable-errors',
    kind: 'guard',
    guards: 'errors discarded the column, expected type and value, causing blind retry loops',
    title: 'a rejected write tells the agent which column and what was expected',
    async run({ c, t, user }) {
      const table = t('errq')
      expectOk(await c.tool('create_table', {
        tableName: table,
        columns: [
          { name: 'user_id', type: 'uuid' },
          { name: 'occurred_at', type: 'timestamp' },
          { name: 'amount', type: 'numeric' },
        ],
      }), 'create_table')

      // Deliberately malformed: a word is not a timestamp.
      const r = await c.dbInsert(table, {
        user_id: user.id,
        occurred_at: 'not-a-date',
        amount: '10.00',
      })
      if (r.ok) fail('malformed timestamp was accepted — validation is missing')

      if (isBlindError(r.error)) {
        fail(
          'error is not self-correctable. Got: ' + JSON.stringify(r.error) +
          ' — it must name the offending column AND the expected type ' +
          '(PostgreSQL already produced both; the error layer discards them).',
        )
      }

      // Prose alone is not enough — a machine-readable contract must survive
      // rewording, and Phase 3 depends on these exact fields.
      const b = r.body ?? {}
      for (const field of ['code', 'column', 'expected', 'example'] as const) {
        if (!b[field]) fail(`structured error is missing "${field}": ${JSON.stringify(b)}`)
      }
      if (b.column !== 'occurred_at') {
        fail(`error blamed the wrong column: got "${b.column}", expected "occurred_at"`)
      }
      if (!/timestamp/i.test(String(b.expected))) {
        fail(`expected type should mention timestamp, got "${b.expected}"`)
      }

      // An unknown column must return the real column list — the single most
      // useful recovery signal, and free because the catalog is already loaded.
      const unknown = await c.dbInsert(table, {
        user_id: user.id, definitely_not_a_column: 1,
      })
      if (unknown.ok) fail('insert into a non-existent column succeeded')
      const available = unknown.body?.available
      if (!Array.isArray(available) || !available.includes('occurred_at')) {
        fail(`unknown-column error must list the real columns, got: ${JSON.stringify(unknown.body)}`)
      }
    },
  },
]
