/**
 * report-admin-keys-in-browsers.ts — who to tell before admin-role keys stop answering browsers.
 *
 * Read-only. Admin-role keys that are not service keys (older projects'
 * Default Keys) still answer browsers until ADMIN_KEYS_SERVER_ONLY_FROM, and
 * every browser use is recorded (ADMIN_KEY_BROWSER_USE,
 * lib/security/admin-key-placement.ts). This lists the keys seen in a browser,
 * with their project's owner and the sites that used them, so the owners can
 * be told the date and how to switch.
 *
 *   npx tsx scripts/report-admin-keys-in-browsers.ts             # the last 30 days
 *   npx tsx scripts/report-admin-keys-in-browsers.ts --days 90
 *
 * One line per key: owner's email, project, key name and prefix, sites, last seen.
 */
import { prisma } from '@/lib/db'
import { ADMIN_KEY_BROWSER_USE } from '@/lib/security/admin-key-placement'

const flag = process.argv.indexOf('--days')
const DAYS = flag > -1 ? Math.max(1, Number(process.argv[flag + 1]) || 30) : 30

async function main(): Promise<void> {
  const since = new Date(Date.now() - DAYS * 86_400_000)
  const rows = await prisma.auditLog.findMany({
    where: { action: ADMIN_KEY_BROWSER_USE, timestamp: { gte: since } },
    select: { projectId: true, details: true, timestamp: true },
    orderBy: { timestamp: 'desc' },
  })
  const byKey = new Map<string, { projectId: string; name: string; prefix: string; origins: Set<string>; last: Date }>()
  for (const r of rows) {
    let d: Record<string, unknown> = {}
    try {
      d = JSON.parse(String(r.details ?? '{}'))
    } catch {
      continue
    }
    const id = typeof d.apiKeyId === 'string' ? d.apiKeyId : null
    if (!id || !r.projectId) continue
    const g = byKey.get(id) ?? { projectId: r.projectId, name: String(d.keyName ?? ''), prefix: String(d.keyPrefix ?? ''), origins: new Set<string>(), last: r.timestamp }
    if (typeof d.origin === 'string' && d.origin) g.origins.add(d.origin)
    if (r.timestamp > g.last) g.last = r.timestamp
    byKey.set(id, g)
  }
  // Keys revoked since, or no longer admin-role, are not a live problem.
  const live = await prisma.apiKey.findMany({
    where: { id: { in: [...byKey.keys()] }, role: 'admin', serviceRole: false },
    select: { id: true, project: { select: { name: true, user: { select: { email: true } } } } },
  })
  for (const k of live) {
    const g = byKey.get(k.id)!
    console.log(
      [k.project?.user?.email ?? '-', `${g.projectId} (${k.project?.name ?? '-'})`, `${g.name} ${g.prefix}…`, [...g.origins].join(' ') || '-', g.last.toISOString()].join('\t'),
    )
  }
  console.log(`${live.length} admin-role key(s) used from a browser in the last ${DAYS} day(s).`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
