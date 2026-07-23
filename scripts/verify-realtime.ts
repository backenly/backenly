/**
 * End-to-end verification of the Realtime rewrite (shared ListenerHub).
 * Run on the server: npx tsx scripts/verify-realtime.ts [projectId] [baseUrl]
 *
 * baseUrl defaults to http://localhost:3001 — the Express runtime that nginx
 * serves for /api/v1 in production.
 *
 * Checks:
 *  1. HTTP SSE connect with the project's anon key (?apiKey=) → `connected`
 *     frame arrives (this was 401-broken in prod: Express auth ignored the
 *     query param that EventSource clients must use)
 *  2. Broadcast POST → the frame arrives on the open SSE stream (full
 *     API → pg_notify → LISTEN → SSE loop)
 *  3. Connection economy: with 5 concurrent SSE streams open, the total
 *     Postgres connection count rises by at most 2 (shared LISTEN — the old
 *     design used one dedicated pg connection per stream)
 *  4. Plan gating: open (cap) streams on a Free project → all connect;
 *     stream cap+1 receives { type:"error", code:"PLAN_LIMIT_EXCEEDED" }
 *  5. Slots release: after closing everything, a fresh connect succeeds
 */
import { prisma } from '../lib/db'

const projectIdArg = process.argv[2]
const BASE = process.argv[3] || 'http://localhost:3001'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

interface SseHandle {
  frames: Record<string, unknown>[]
  waitFor: (pred: (f: Record<string, unknown>) => boolean, timeoutMs: number) => Promise<Record<string, unknown> | null>
  close: () => void
}

async function openSse(url: string): Promise<SseHandle> {
  const controller = new AbortController()
  const res = await fetch(url, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  })
  if (!res.ok || !res.body) {
    controller.abort()
    throw new Error(`SSE connect failed: HTTP ${res.status}`)
  }

  const frames: Record<string, unknown>[] = []
  const waiters: Array<{ pred: (f: Record<string, unknown>) => boolean; resolve: (f: Record<string, unknown>) => void }> = []

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  ;(async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''
        for (const part of parts) {
          const dataLine = part.split('\n').find(l => l.startsWith('data: '))
          if (!dataLine) continue
          try {
            const frame = JSON.parse(dataLine.slice(6))
            frames.push(frame)
            for (let i = waiters.length - 1; i >= 0; i--) {
              if (waiters[i].pred(frame)) {
                waiters[i].resolve(frame)
                waiters.splice(i, 1)
              }
            }
          } catch { /* keepalive or malformed */ }
        }
      }
    } catch { /* aborted */ }
  })()

  return {
    frames,
    waitFor: (pred, timeoutMs) =>
      new Promise((resolve) => {
        const existing = frames.find(pred)
        if (existing) return resolve(existing)
        const timer = setTimeout(() => resolve(null), timeoutMs)
        waiters.push({ pred, resolve: (f) => { clearTimeout(timer); resolve(f) } })
      }),
    close: () => controller.abort(),
  }
}

async function pgConnectionCount(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ cnt: bigint }>>(
    `SELECT count(*) AS cnt FROM pg_stat_activity WHERE datname = current_database()`
  )
  return Number(rows[0]?.cnt ?? 0)
}

async function main() {
  // ── Resolve a Free-plan project with an anon key ───────────────────────────
  const project = projectIdArg
    ? await prisma.project.findUnique({ where: { id: projectIdArg }, select: { id: true, name: true, anonKey: true, userId: true } })
    : await prisma.project.findFirst({ where: { anonKey: { not: null } }, select: { id: true, name: true, anonKey: true, userId: true } })

  if (!project?.anonKey) {
    check('project with anon key', false, projectIdArg ? `project ${projectIdArg} has no anonKey` : 'none found')
    return
  }
  console.log(`Project: ${project.name} (${project.id})`)

  const sub = await prisma.subscription.findFirst({
    where: { userId: project.userId },
    orderBy: { createdAt: 'desc' },
    include: { plan: { select: { name: true, maxRealtimeConnections: true } } },
  })
  const cap = sub?.plan.maxRealtimeConnections ?? null
  console.log(`Plan: ${sub?.plan.name} — realtime cap: ${cap ?? 'unlimited'}\n`)

  const sseUrl = `${BASE}/api/v1/${project.id}/realtime?apiKey=${encodeURIComponent(project.anonKey)}`

  // ── 1. Single SSE connect ──────────────────────────────────────────────────
  console.log('1. SSE connect via ?apiKey= (the EventSource path)')
  let first: SseHandle | null = null
  try {
    first = await openSse(sseUrl)
    const connected = await first.waitFor(f => f.type === 'connected', 5_000)
    check('receives `connected` frame', !!connected, JSON.stringify(first.frames.slice(0, 2)))
  } catch (err: any) {
    check('SSE connection opens', false, err.message)
  }

  // ── 2. Broadcast round-trip ────────────────────────────────────────────────
  console.log('\n2. Broadcast → SSE round-trip')
  if (first) {
    const res = await fetch(`${BASE}/api/v1/${project.id}/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': project.anonKey },
      body: JSON.stringify({ channel: 'verify-rt', payload: { ping: Date.now() } }),
    })
    check('broadcast POST accepted', res.ok, `HTTP ${res.status}`)
    const frame = await first.waitFor(f => f.type === 'broadcast' && f.channel === 'verify-rt', 5_000)
    check('broadcast frame arrives on stream', !!frame)
  }

  // ── 3. Connection economy ──────────────────────────────────────────────────
  console.log('\n3. Connection economy (shared LISTEN)')
  const before = await pgConnectionCount()
  const extra: SseHandle[] = []
  try {
    for (let i = 0; i < 5; i++) extra.push(await openSse(sseUrl))
    await Promise.all(extra.map(h => h.waitFor(f => f.type === 'connected' || f.type === 'error', 5_000)))
    const during = await pgConnectionCount()
    check(`5 extra SSE streams add ≤ 2 pg connections`, during - before <= 2, `before=${before} during=${during}`)
  } catch (err: any) {
    check('open 5 concurrent streams', false, err.message)
  }

  // ── 4. Plan cap enforcement ────────────────────────────────────────────────
  console.log('\n4. Plan cap enforcement')
  const held: SseHandle[] = [...extra]
  if (first) held.push(first)
  if (cap !== null && cap <= 200) {
    try {
      while (held.length < cap) held.push(await openSse(sseUrl))
      // Give the server a beat to register the last few subscriptions.
      await Promise.all(held.slice(-5).map(h => h.waitFor(f => f.type === 'connected' || f.type === 'error', 5_000)))

      const overflow = await openSse(sseUrl)
      const errFrame = await overflow.waitFor(f => f.type === 'error', 5_000)
      check(`connection ${cap + 1} is refused`, !!errFrame, JSON.stringify(overflow.frames.slice(0, 2)))
      check('refusal carries PLAN_LIMIT_EXCEEDED', (errFrame as any)?.code === 'PLAN_LIMIT_EXCEEDED', JSON.stringify(errFrame))
      overflow.close()
    } catch (err: any) {
      check('cap test', false, err.message)
    }
  } else {
    console.log(`  (cap is ${cap ?? 'unlimited'} — too large to exercise; skipped)`)
  }

  // ── 5. Slots release ───────────────────────────────────────────────────────
  console.log('\n5. Slot release after disconnect')
  for (const h of held) h.close()
  await new Promise(r => setTimeout(r, 1_500))
  try {
    const fresh = await openSse(sseUrl)
    const connected = await fresh.waitFor(f => f.type === 'connected', 5_000)
    check('fresh connect succeeds after mass close', !!connected)
    fresh.close()
  } catch (err: any) {
    check('fresh connect succeeds after mass close', false, err.message)
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`)
  if (fail > 0) process.exit(1)
}

main()
  .catch(e => { console.error('❌ Verifier crashed:', e); process.exit(1) })
  .finally(() => prisma.$disconnect())
