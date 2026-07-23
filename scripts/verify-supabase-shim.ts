/**
 * Behavioral verifier for the supabase-js compatibility shim.
 *
 * Boots a stub Backenly runtime that records every request body, then drives
 * the generated ESM bundle (public/backenly-supabase.esm.js — the file real
 * frontends import) through the supabase-js surface: filter chains, single(),
 * inserts/updates/deletes, refusal paths, auth. Asserts BOTH the wire format
 * (exact where-operator mapping) and the { data, error } result contract.
 *
 * Run: node scripts/build-sdk.mjs && npx tsx scripts/verify-supabase-shim.ts
 */
import http from 'http'
import path from 'path'
import { pathToFileURL } from 'url'

const PROJECT_ID = '0e05907b-dab8-4278-87f1-ba792eb01b36'
const captured: Array<{ path: string; body: any }> = []

const stub = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null
    captured.push({ path: req.url ?? '', body })
    res.writeHead(200, { 'content-type': 'application/json' })

    if (req.url?.includes('/database/query')) {
      const rows = body?.table === 'empty' ? [] : [{ id: '1', title: 'A' }, { id: '2', title: 'B' }]
      return res.end(JSON.stringify({ success: true, data: { data: rows, count: rows.length } }))
    }
    if (req.url?.includes('/database/insert')) {
      return res.end(JSON.stringify({ success: true, data: { id: '9', ...((Array.isArray(body?.data) ? body.data[0] : body?.data) ?? {}) } }))
    }
    if (req.url?.includes('/database/update')) {
      return res.end(JSON.stringify({ success: true, data: { id: '1', updated: true } }))
    }
    if (req.url?.includes('/database/delete')) {
      return res.end(JSON.stringify({ success: true, data: { deleted: 1 } }))
    }
    if (req.url?.includes('/auth/signup') || req.url?.includes('/auth/signin')) {
      return res.end(JSON.stringify({ success: true, data: { user: { id: 'u1', email: body?.email }, token: 'jwt-token' } }))
    }
    res.end(JSON.stringify({ success: true, data: {} }))
  })
})

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++
  console.log(`${ok ? '✔' : '✖'} ${label}${!ok && detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ''}`)
}

function lastBody(pathPart: string): any {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (captured[i].path.includes(pathPart)) return captured[i].body
  }
  return null
}

async function main() {
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r))
  const port = (stub.address() as any).port

  // Import the REAL generated artifact — the file frontends will load.
  const bundle = pathToFileURL(path.resolve(__dirname, '..', 'public', 'backenly-supabase.esm.js')).href
  const { createClient } = await import(bundle)

  const supabase = createClient(`http://127.0.0.1:${port}/api/v1/${PROJECT_ID}`, 'anon-key')

  // ── filter chain → wire format ───────────────────────────────────────────────
  const sel = await supabase.from('posts').select('*')
    .eq('status', 'published').neq('author', 'bob').gt('views', 10).lte('score', 5)
    .in('tag', ['a', 'b']).ilike('title', '%launch%').is('deleted_at', null)
    .order('created_at', { ascending: false }).limit(10)

  check('select resolves { data, error:null }', sel.error === null && Array.isArray(sel.data) && sel.data.length === 2, sel)
  const q = lastBody('/database/query')
  check('eq maps to bare value', q?.where?.status === 'published', q?.where)
  check('neq maps to {not}', q?.where?.author?.not === 'bob', q?.where)
  check('gt/lte merge into one operator object', q?.where?.views?.gt === 10 && q?.where?.score?.lte === 5, q?.where)
  check('in maps to {in:[…]}', Array.isArray(q?.where?.tag?.in) && q.where.tag.in.length === 2, q?.where)
  check('ilike strips % → {contains}', q?.where?.title?.contains === 'launch', q?.where)
  check('is(null) maps to null (IS NULL)', q?.where?.deleted_at === null, q?.where)
  check('order maps to {col:desc}', q?.orderBy?.created_at === 'desc', q?.orderBy)
  check('limit carried', q?.limit === 10, q?.limit)

  // range → offset/limit
  await supabase.from('posts').select('*').range(20, 29)
  const qr = lastBody('/database/query')
  check('range(20,29) → offset 20 limit 10', qr?.offset === 20 && qr?.limit === 10, qr)

  // single / maybeSingle semantics
  const one = await supabase.from('posts').select('*').eq('id', '1').single()
  check('single() returns first row as object', one.error === null && one.data?.id === '1', one)
  const none = await supabase.from('empty').select('*').single()
  check('single() with 0 rows → PGRST116 error', none.data === null && none.error?.code === 'PGRST116', none)
  const noneMaybe = await supabase.from('empty').select('*').maybeSingle()
  check('maybeSingle() with 0 rows → null, no error', noneMaybe.data === null && noneMaybe.error === null, noneMaybe)

  // count
  const counted = await supabase.from('posts').select('*', { count: 'exact' })
  check('select(count:exact) surfaces count', counted.count === 2, counted)

  // ── mutations ────────────────────────────────────────────────────────────────
  const ins = await supabase.from('posts').insert({ title: 'New' }).select()
  check('insert resolves created row', ins.error === null && ins.data?.title === 'New', ins)

  const upd = await supabase.from('posts').update({ title: 'X' }).eq('id', '1')
  check('update sends where + data', upd.error === null && lastBody('/database/update')?.where?.id === '1', upd)

  const del = await supabase.from('posts').delete().eq('id', '2')
  check('delete sends where', del.error === null && lastBody('/database/delete')?.where?.id === '2', del)

  // Refusals — never throw, never fire unfiltered mutations
  const noFilterUpd = await supabase.from('posts').update({ a: 1 })
  check('unfiltered update refused with NO_FILTER', noFilterUpd.error?.code === 'NO_FILTER', noFilterUpd.error)
  const orRes = await supabase.from('posts').select('*').or('a.eq.1,b.eq.2')
  check('.or() refused with UNSUPPORTED', orRes.error?.code === 'UNSUPPORTED', orRes.error)
  const rpcRes = await supabase.rpc('do_thing')
  check('rpc() refused with Backenly guidance', rpcRes.error?.code === 'UNSUPPORTED' && rpcRes.error.message.includes('function'), rpcRes.error)

  // ── auth ─────────────────────────────────────────────────────────────────────
  const su = await supabase.auth.signUp({ email: 'a@b.c', password: 'hunter22' })
  check('auth.signUp returns { user, session }', su.error === null && su.data.user?.email === 'a@b.c' && su.data.session?.access_token === 'jwt-token', su)
  const si = await supabase.auth.signInWithPassword({ email: 'a@b.c', password: 'hunter22' })
  check('auth.signInWithPassword returns session', si.error === null && si.data.session?.access_token === 'jwt-token', si)

  // createClient URL validation
  let threw = false
  try { createClient('https://backenly.com/api/v1/not-a-uuid', 'k') } catch { threw = true }
  check('createClient rejects URL without project id', threw)

  await new Promise((r) => stub.close(r))
  if (failures > 0) {
    console.error(`\n✖ ${failures} shim verification(s) failed`)
    process.exitCode = 1
    return
  }
  console.log('\n✔ supabase-js compat shim verified against the generated bundle')
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
