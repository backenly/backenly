/**
 * Verifier for the read-only SQL console guard (lib/sql-console/guard.ts).
 * Pure functions — covers admits, refusals, and bypass attempts.
 *
 * Run: npx tsx scripts/verify-sql-guard.ts
 */
import { validateConsoleSql, normalizeSql } from '../lib/sql-console/guard'

const PROJECT = '0e05907b-dab8-4278-87f1-ba792eb01b36'
let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++
  console.log(`${ok ? '✔' : '✖'} ${label}${!ok && detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ''}`)
}

const v = (sql: string) => validateConsoleSql(sql, PROJECT)

// ── admits ─────────────────────────────────────────────────────────────────────
check('plain select admitted', v('SELECT * FROM posts LIMIT 10').ok)
check('trailing semicolon tolerated', v('select id from posts;').ok)
check('WITH … SELECT admitted', v('WITH t AS (SELECT 1 AS n) SELECT * FROM t').ok)
check('EXPLAIN select admitted as explain', (() => { const r = v('EXPLAIN SELECT * FROM posts'); return r.ok && r.kind === 'explain' })())
check("string containing 'delete' is fine", v("SELECT * FROM posts WHERE title = 'delete me later'").ok)
check("string containing 'public.' is fine", v("SELECT * FROM posts WHERE note = 'see public.users'").ok)
check('dollar-quoted literal with writes inside is fine', v("SELECT $tag$DROP TABLE x; public.users$tag$ AS s").ok)
check('own workspace schema qualifier allowed', v(`SELECT * FROM "workspace_${PROJECT}".posts`).ok)

// ── write refusals (the funnel) ────────────────────────────────────────────────
const upd = v("UPDATE posts SET title = 'x' WHERE id = 1")
check('UPDATE refused as write', !upd.ok && upd.kind === 'write')
check('write refusal carries governed-change suggestion', !upd.ok && 'suggestion' in upd && !!upd.suggestion?.includes('governed'))
check('DROP refused', (() => { const r = v('DROP TABLE posts'); return !r.ok && r.kind === 'write' })())
check('INSERT refused', (() => { const r = v("INSERT INTO posts (title) VALUES ('x')"); return !r.ok && r.kind === 'write' })())
check('EXPLAIN over a write refused', (() => { const r = v('EXPLAIN ANALYZE DELETE FROM posts'); return !r.ok && r.kind === 'write' })())
check('SET refused (session tampering)', (() => { const r = v("SET search_path = public"); return !r.ok && r.kind === 'write' })())

// ── bypass attempts ────────────────────────────────────────────────────────────
check('multi-statement refused', (() => { const r = v('SELECT 1; DROP TABLE posts'); return !r.ok && r.kind === 'multi' })())
check('comment-hidden second statement refused', (() => { const r = v('SELECT 1 /* sneaky */ ; DELETE FROM posts'); return !r.ok })())
check('public schema read denied', (() => { const r = v('SELECT * FROM public.users'); return !r.ok && r.kind === 'denied' })())
check('quoted public schema still denied', (() => { const r = v('SELECT * FROM "public" . "api_keys"'); return !r.ok })())
check('pg_catalog denied', (() => { const r = v('SELECT * FROM pg_catalog.pg_tables'); return !r.ok && r.kind === 'denied' })())
check('information_schema denied', (() => { const r = v('SELECT * FROM information_schema.tables'); return !r.ok && r.kind === 'denied' })())
check("another project's workspace denied", (() => { const r = v('SELECT * FROM workspace_ffffffff-1111-2222-3333-444444444444.users'); return !r.ok && r.kind === 'denied' })())
check('set_config() denied', (() => { const r = v("SELECT set_config('app.is_service_role','true',true)"); return !r.ok && r.kind === 'denied' })())
check('current_setting() denied', (() => { const r = v("SELECT current_setting('app.current_user_id')"); return !r.ok && r.kind === 'denied' })())
check('pg_read_file() denied', (() => { const r = v("SELECT pg_read_file('/etc/passwd')"); return !r.ok && r.kind === 'denied' })())
check('pg_sleep() denied', (() => { const r = v('SELECT pg_sleep(60)'); return !r.ok && r.kind === 'denied' })())
check('deny survives case tricks', (() => { const r = v('SELECT * FROM PuBlIc.users'); return !r.ok })())
check('deny survives comment splitting of qualifier', (() => { const r = v('SELECT * FROM public/*x*/.users'); return !r.ok })())

// ── normalizer ─────────────────────────────────────────────────────────────────
check('normalizer strips line comments', !normalizeSql('SELECT 1 -- public.users\n').includes('public'))
check('normalizer strips nested block comments', !normalizeSql('SELECT 1 /* a /* public.x */ b */').includes('public'))
check("normalizer collapses '' escapes", normalizeSql("SELECT 'it''s public.'").includes("''") && !normalizeSql("SELECT 'it''s public.x'").includes('public'))

// ── executor ──────────────────────────────────────────────────────────────────
// Statement building moved to lib/mcp/read-query.ts (timeout, schema pin and
// row cap now live with execution, which runs as the project's read-only role).
// Its behaviour is covered by tests/unit/mcp-read-query-guards.spec.ts and the
// privilege boundary by tests/probes/read-query-isolation.spec.ts — asserting it
// here too would re-verify a path this file no longer owns.

if (failures > 0) {
  console.error(`\n✖ ${failures} SQL-guard verification(s) failed`)
  process.exitCode = 1
} else {
  console.log('\n✔ SQL console guard verified (admits, refusals, bypass attempts)')
}
