/**
 * Connection health counts the last day where the rows are (production QA,
 * 2026-11-09).
 *
 * GET /connection-health read every SDK bootstrap and key failure of the last
 * day, up to 5,000 rows with their JSON, to count them in the web process:
 * about 65 ms of CPU per call for a busy app, and every console page asked two
 * to five times. A busier day was also counted short, at the 5,000 most recent.
 * The database now counts them; the rules for what each count means are the
 * same.
 */
import '../helpers/next-request-polyfill'
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { generateToken } from '@/lib/auth/jwt'
import { GET } from '@/app/api/projects/[id]/connection-health/route'

let ownerId: string
let projectId: string
let otherProjectId: string
let token: string
const originalEdition = process.env.BACKENLY_EDITION
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  const email = `connection-health-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email, password: 'not-a-real-hash', name: 'Connection Health' } })).id
  projectId = (await prisma.project.create({ data: { name: 'connection-health', userId: ownerId } })).id
  otherProjectId = (await prisma.project.create({ data: { name: 'connection-health-other', userId: ownerId } })).id
  token = generateToken({ userId: ownerId, email })
  await prisma.session.create({ data: { userId: ownerId, token, expiresAt: new Date(Date.now() + 3600_000) } })

  const event = (kind: 'bootstrap' | 'auth_failure', at: Date, detail: Record<string, unknown>, project = projectId) =>
    ({ kind, severity: 'info', projectId: project, summary: kind, detail: detail as any, createdAt: at })
  const failure = (origin: string | null, at: Date) =>
    event('auth_failure', at, { kind: 'unknown_key', sentKeyShape: 'proj_live_…(56)', origin, path: '/api/v1/p/db/orders', method: 'GET' })

  await prisma.securityEvent.createMany({
    data: [
      // More bootstraps in a day than the old read's 5,000 rows.
      ...Array.from({ length: 6000 }, (_, i) => event('bootstrap', minutesAgo(1 + (i % 1400)), { origin: 'https://shop.example.com', provisioned: false })),
      ...Array.from({ length: 40 }, (_, i) => event('bootstrap', minutesAgo(30 + i), { origin: 'https://preview.shop.example.com:8443/cart' })),
      // One host, two URLs, one kind and key shape: one group. Ten in the last hour.
      ...Array.from({ length: 30 }, (_, i) => failure('https://shop.example.com/checkout', minutesAgo(i < 10 ? 5 + i : 90 + i))),
      ...Array.from({ length: 5 }, (_, i) => failure('https://shop.example.com', minutesAgo(200 + i))),
      // No Origin: curl or a scanner, counted quietly.
      ...[10, 50, 70, 80].map((m) => failure(null, minutesAgo(m))),
      // The platform's own pages, and anything older than a day: not counted.
      ...Array.from({ length: 3 }, () => failure('https://backenly.com', minutesAgo(3))),
      failure('https://shop.example.com', minutesAgo(25 * 60)),
      event('bootstrap', minutesAgo(26 * 60), { origin: 'https://shop.example.com' }),
      // Another project's events.
      ...Array.from({ length: 20 }, () => event('auth_failure', minutesAgo(2), { kind: 'missing', origin: 'https://other.example.com' }, otherProjectId)),
      ...Array.from({ length: 20 }, () => event('bootstrap', minutesAgo(2), { origin: 'https://other.example.com' }, otherProjectId)),
    ],
  })
}, 120_000)

afterAll(async () => {
  await prisma.securityEvent.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } })
  await prisma.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  process.env.BACKENLY_EDITION = originalEdition
}, 120_000)

it('counts the whole day by origin, kind and key shape, as the activity card reads it', async () => {
  const res = await GET(new NextRequest(`https://backenly.test/api/projects/${projectId}/connection-health`, {
    headers: { cookie: `auth-token=${token}` },
  }))
  expect(res.status).toBe(200)
  const body = await res.json()

  expect(body.successes.map((s: any) => ({ origin: s.origin, count: s.count }))).toEqual([
    { origin: 'shop.example.com', count: 6000 },
    { origin: 'preview.shop.example.com:8443', count: 40 },
  ])
  expect(new Date(body.successes[0].lastSeen).getTime()).toBeGreaterThan(minutesAgo(3).getTime())

  expect(body.failures).toEqual([
    expect.objectContaining({ origin: 'shop.example.com', kind: 'unknown_key', sentKeyShape: 'proj_live_…(56)', count: 35 }),
  ])
  // The most recent of the group's two URLs.
  expect(new Date(body.failures[0].lastSeen).getTime()).toBeGreaterThan(minutesAgo(7).getTime())
  expect(body.failures[0].hint).toMatch(/doesn't match any active key/)

  expect(body.probes.count).toBe(4)
  expect(new Date(body.probes.lastSeen).getTime()).toBeGreaterThan(minutesAgo(12).getTime())
  expect(body.totals).toEqual({
    failures24h: 35,
    failures1h: 10,
    bootstraps24h: 6040,
    // No request-log rows here: every success is a bootstrap ping.
    requests24h: 6040,
    distinctOriginsFailing: 1,
    distinctOriginsConnected: 2,
  })
  expect(body.summaryText).toMatch(/^35 requests from shop\.example\.com failed/)
}, 60_000)

it('answers a project with nothing to show', async () => {
  await prisma.securityEvent.deleteMany({ where: { projectId: otherProjectId } })
  const res = await GET(new NextRequest(`https://backenly.test/api/projects/${otherProjectId}/connection-health`, {
    headers: { cookie: `auth-token=${token}` },
  }))
  expect(await res.json()).toEqual({
    failures: [],
    successes: [],
    probes: { count: 0, lastSeen: null },
    totals: { failures24h: 0, failures1h: 0, bootstraps24h: 0, requests24h: 0, distinctOriginsFailing: 0, distinctOriginsConnected: 0 },
    summaryText: '',
  })
}, 60_000)
