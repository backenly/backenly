/**
 * MCP reliability harness — runner.
 *
 *   npx tsx scripts/mcp-harness/run.ts --key mcp_live_… [--endpoint https://backenly.com]
 *
 * Env fallbacks: BACKENLY_MCP_KEY, BACKENLY_API_URL.
 *
 * Exit code is 0 only when every guard and golden case passes. `target` cases
 * encode standards not yet met (Phase 1) — they are reported and, by default,
 * do not fail the run. Pass --strict to require them too, which is how the gate
 * flips once Phase 1 lands.
 *
 * Cleanup: dropping tables is deliberately not executable over MCP (destructive
 * operations route to the human Review Queue), so the run prints the SQL needed
 * to remove its own artefacts rather than pretending it cleaned up.
 */

import { HarnessClient } from './client.js'
import { CASES, type Case, type Ctx } from './cases.js'

interface Outcome {
  case: Case
  status: 'pass' | 'fail' | 'skip'
  detail?: string
  turns: number
  blindErrors: number
  ms: number
}

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue }
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { out[a.slice(2)] = next; i++ }
    else out[a.slice(2)] = true
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const apiKey = String(args.key ?? process.env.BACKENLY_MCP_KEY ?? '')
  const endpoint = String(args.endpoint ?? process.env.BACKENLY_API_URL ?? 'https://backenly.com')
  const strict = !!args.strict

  if (!apiKey) {
    console.error('Missing MCP key. Pass --key mcp_live_… or set BACKENLY_MCP_KEY.')
    process.exit(2)
  }

  // Short, collision-resistant namespace so a run never touches real tables and
  // concurrent runs never touch each other.
  const runId = Math.random().toString(36).slice(2, 8)
  const client = new HarnessClient(endpoint, apiKey)
  const created: string[] = []
  const tableName = (name: string) => {
    const full = `hx_${runId}_${name}`.toLowerCase().slice(0, 63)
    if (!created.includes(full)) created.push(full)
    return full
  }

  console.log(`\n  MCP reliability harness`)
  console.log(`  endpoint ${endpoint}`)
  console.log(`  run      hx_${runId}\n`)

  const health = await client.tool('get_project_overview')
  if (!health.ok) {
    console.error(`  cannot reach project: ${health.error}`)
    process.exit(2)
  }
  client.projectId = health.data?.projectId ?? ''
  if (!client.projectId) {
    console.error('  project overview returned no projectId — runtime contract cases cannot run')
    process.exit(2)
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  // Mint a runtime key and sign up a REAL end-user. Seeds must reference a real
  // users row, because `user_id` columns carry a foreign key to users. A literal
  // 1111… uuid only worked while the project had no users table — the harness
  // was green for the wrong reason, which is the exact failure mode it exists
  // to catch, so it must not commit it itself.
  const keyRes = await client.tool('create_api_key', { description: `mcp-harness ${runId}` })
  const runtimeKey = String(keyRes.data?.apiKey ?? '')
  if (!keyRes.ok || !runtimeKey) {
    console.error(`  could not mint a runtime key: ${keyRes.error}`)
    process.exit(2)
  }

  const signup = await client.runtime('POST', '/auth/signup', runtimeKey, {
    body: { email: `harness+${runId}@backenly.test`, password: 'Harness!2345' },
  })
  const user = {
    id: signup.body?.data?.user?.id ?? signup.body?.user?.id ?? '',
    token: signup.body?.data?.token ?? signup.body?.token ?? '',
  }
  if (!user.id || !user.token) {
    console.error(`  end-user signup failed (HTTP ${signup.status}): ${JSON.stringify(signup.body)?.slice(0, 200)}`)
    process.exit(2)
  }
  console.log(`  user     ${user.id}\n`)

  const ctx: Ctx = { c: client, t: tableName, user, runtimeKey }

  const outcomes: Outcome[] = []
  for (const testCase of CASES) {
    if (testCase.skip) {
      outcomes.push({ case: testCase, status: 'skip', detail: testCase.skip, turns: 0, blindErrors: 0, ms: 0 })
      process.stdout.write(`  SKIP  ${testCase.id}\n`)
      continue
    }

    const marker = client.mark()
    const started = Date.now()
    let status: Outcome['status'] = 'pass'
    let detail: string | undefined

    try {
      await testCase.run(ctx)
    } catch (err) {
      status = 'fail'
      detail = err instanceof Error ? err.message : String(err)
    }

    const calls = client.since(marker)
    outcomes.push({
      case: testCase,
      status,
      detail,
      turns: calls.length,
      blindErrors: calls.filter((c) => c.blind).length,
      ms: Date.now() - started,
    })

    const tag = status === 'pass' ? 'PASS' : 'FAIL'
    process.stdout.write(`  ${tag}  ${testCase.id}  (${calls.length} calls, ${Date.now() - started}ms)\n`)
    if (detail) process.stdout.write(`        ${detail}\n`)
  }

  // ── report ────────────────────────────────────────────────────────────────
  const guards = outcomes.filter((o) => o.case.kind === 'guard' && o.status !== 'skip')
  const goldens = outcomes.filter((o) => o.case.kind === 'golden')
  const targets = outcomes.filter((o) => o.case.kind === 'target')
  const blockingFailures = [...guards, ...goldens].filter((o) => o.status === 'fail')
  const targetFailures = targets.filter((o) => o.status === 'fail')

  const totalCalls = client.calls.length
  const totalBlind = client.calls.filter((c) => c.blind).length
  const failedCalls = client.calls.filter((c) => !c.ok).length

  console.log(`\n  ── score ──────────────────────────────────────────────`)
  console.log(`  guards      ${guards.filter(o => o.status === 'pass').length}/${guards.length} passing`)
  console.log(`  golden      ${goldens.filter(o => o.status === 'pass').length}/${goldens.length} passing`)
  console.log(`  targets     ${targets.filter(o => o.status === 'pass').length}/${targets.length} passing  (Phase 1 standards)`)
  console.log(`  calls       ${totalCalls} total · ${failedCalls} failed`)
  console.log(
    `  blind errs  ${totalBlind}` +
    (totalBlind > 0
      ? `  ← failures an agent cannot self-correct from (retry driver)`
      : ''),
  )

  if (targetFailures.length > 0 && !strict) {
    console.log(`\n  ${targetFailures.length} target case(s) failing — expected until Phase 1 lands.`)
    for (const t of targetFailures) console.log(`    · ${t.case.id}`)
  }

  if (created.length > 0) {
    console.log(`\n  Artefacts left behind (destructive ops are Review-Queue gated by design):`)
    console.log(`    DROP TABLE IF EXISTS ${created.map((t) => `"${t}"`).join(', ')} CASCADE;`)
  }

  const failed = blockingFailures.length > 0 || (strict && targetFailures.length > 0)
  console.log(`\n  ${failed ? 'FAILED' : 'OK'}\n`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error('harness crashed:', err instanceof Error ? err.stack : err)
  process.exit(2)
})
