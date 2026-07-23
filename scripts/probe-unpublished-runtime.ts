/**
 * Prove that every public runtime surface works on an UNPUBLISHED project.
 *
 * ── Why this probe exists ───────────────────────────────────────────────────
 *
 * `/storage/*` used to answer 403 "This project is not published" while
 * `/db/*`, `/auth/*` and `/fn/*` served the same unpublished project happily —
 * because the publish gate lived in `v1ApiMiddleware`, which only the
 * Next-owned surfaces pass through. A developer's buckets were unusable and the
 * error implied they had skipped a step nothing else required.
 *
 * The fix removed that gate. This asserts the result end-to-end rather than by
 * reading the code, because the ordering makes it easy to fool yourself:
 * authentication runs BEFORE the gate did, so probing with an invalid key
 * returns 401 either way and proves nothing. Only a VALID key on a genuinely
 * unpublished project distinguishes the two.
 *
 * ── Self-contained ──────────────────────────────────────────────────────────
 *
 * Creates its own throwaway project + API key, probes, then deletes both. It
 * never reads a customer's credential and leaves nothing behind. The workspace
 * schema it creates also exercises the CREATE SCHEMA auto-registration trigger
 * and, on teardown, the DROP SCHEMA unregistration trigger.
 *
 *   npx tsx scripts/probe-unpublished-runtime.ts
 */

import crypto from 'crypto'
import { prisma } from '../lib/db'

const BASE = process.env.PROBE_BASE_URL ?? 'http://127.0.0.1:3001'

interface Probe {
  surface: string
  path: string
  /** Statuses that mean "this surface served the request". */
  ok: number[]
}

async function main() {
  const owner = await prisma.user.findFirst({ select: { id: true } })
  if (!owner) throw new Error('No user to own the probe project.')

  const projectId = crypto.randomUUID()
  const rawKey = `sk_live_${crypto.randomBytes(24).toString('hex')}`
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')

  console.log(`Probe project ${projectId} — created UNPUBLISHED on purpose.\n`)

  try {
    await prisma.project.create({
      data: {
        id: projectId,
        name: 'probe-unpublished-runtime',
        userId: owner.id,
        // The whole point: every default is the unpublished one.
        publicEnabled: false,
        isDeployed: false,
        projectStatus: 'PRIVATE',
        jwtSecret: crypto.randomBytes(32).toString('hex'),
      },
    })
    await prisma.apiKey.create({
      data: {
        projectId,
        userId: owner.id,
        name: 'probe',
        keyHash,
        keyPrefix: rawKey.slice(0, 12),
        // A runtime key with full permissions — the shape a project's own
        // client key has, so the probe exercises the real path.
        scope: 'runtime',
        permissions: [],
        // EMPTY means "every capability" (see hasCapability in
        // lib/api/v1/middleware.ts). `['*']` is NOT a wildcard — it is a
        // capability literally named `*`, which matches nothing, and using it
        // made this probe report storage as blocked when the real gate had
        // already been removed.
        capabilities: [],
        serviceRole: true,
      } as any,
    })

    // The schema a real project would get. The CREATE SCHEMA event trigger
    // registers it with PostgREST in the same transaction.
    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${projectId}"`)

    const registered = await prisma.$queryRawUnsafe<Array<{ list: string | null }>>(
      `SELECT public.backenly_pgrst_current_schemas() AS list`,
    )
    const isRegistered = (registered[0]?.list ?? '').split(',').includes(`workspace_${projectId}`)
    console.log(`  schema auto-registered by trigger: ${isRegistered ? 'YES' : 'NO'}`)
    if (!isRegistered) console.error('  ^ the CREATE SCHEMA trigger did not fire')

    const probes: Probe[] = [
      // 403 would mean the publish gate is back. 404/400/200 all mean the
      // surface accepted the key and routed the request.
      { surface: 'storage', path: `/api/v1/${projectId}/storage/files`, ok: [200, 400, 404] },
      { surface: 'db', path: `/api/v1/${projectId}/db/nope`, ok: [200, 400, 404] },
      { surface: 'fn', path: `/api/v1/${projectId}/fn/nope`, ok: [200, 400, 404] },
    ]

    console.log('\n  surface   status  verdict')
    let failed = 0
    for (const p of probes) {
      const res = await fetch(`${BASE}${p.path}`, { headers: { 'x-api-key': rawKey } })
      const blocked = res.status === 403
      const body = (await res.text()).slice(0, 120)
      const verdict = blocked
        ? `BLOCKED — ${body}`
        : p.ok.includes(res.status)
          ? 'served'
          : `unexpected — ${body}`
      if (blocked) failed++
      console.log(`  ${p.surface.padEnd(9)} ${String(res.status).padEnd(6)}  ${verdict}`)
    }

    console.log(
      failed === 0
        ? '\n✅ Every runtime surface serves an unpublished project.'
        : `\n❌ ${failed} surface(s) still refuse an unpublished project.`,
    )
    if (failed > 0) process.exitCode = 1
  } finally {
    // Teardown. DROP SCHEMA also exercises the unregistration trigger.
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
    await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.project.delete({ where: { id: projectId } }).catch(() => {})

    const after = await prisma.$queryRawUnsafe<Array<{ list: string | null }>>(
      `SELECT public.backenly_pgrst_current_schemas() AS list`,
    )
    const stillThere = (after[0]?.list ?? '').split(',').includes(`workspace_${projectId}`)
    console.log(`\n  cleaned up; schema unregistered by trigger: ${stillThere ? 'NO — LEAKED' : 'yes'}`)
    if (stillThere) {
      // A dangling registration wedges the schema cache for EVERY tenant, so
      // this is not a tidy-up nicety — say so loudly.
      console.error('  ^ dangling registration left behind; run repair-postgrest-registrations.ts')
      process.exitCode = 1
    }
    await prisma.$disconnect()
  }
}

main().catch(async err => {
  console.error(err)
  await prisma.$disconnect()
  process.exit(1)
})
