/**
 * GET /api/regions: the region picker's source for what customers may choose
 * on the running deployment (lib/regions.ts, BACKENLY_OPEN_REGIONS).
 *
 *   - a self-hosted deployment has no regions, so the route does not exist;
 *   - on Cloud it lists the five regions, each with `open` as this deployment
 *     serves it, and nothing else: no per-account preview or staging regions.
 */

import fs from 'fs'
import path from 'path'

import { GET } from '@/app/api/regions/route'

describe('GET /api/regions', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('does not exist on a self-hosted deployment', async () => {
    delete process.env.BACKENLY_EDITION
    process.env.BACKENLY_OPEN_REGIONS = 'us-east-1'
    const res = GET()
    expect(res.status).toBe(404)
  })

  it('lists the five regions with what customers may choose on this deployment', async () => {
    process.env.BACKENLY_EDITION = 'cloud'
    process.env.BACKENLY_OPEN_REGIONS = 'us-east-1'
    process.env.BACKENLY_PREVIEW_REGIONS = 'eu-central-1'
    process.env.BACKENLY_PREVIEW_USER_IDS = 'founder-a'
    const res = GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.home).toBe('ap-south-1')
    expect(body.regions).toHaveLength(5)
    expect(body.regions.filter((r: { open: boolean }) => r.open).map((r: { id: string }) => r.id).sort()).toEqual(['ap-south-1', 'us-east-1'])
    for (const region of body.regions) {
      expect(Object.keys(region).sort()).toEqual(['area', 'city', 'country', 'countryCode', 'id', 'open'])
    }
  })

  it('lists only the home region as open when nothing else is opened', async () => {
    process.env.BACKENLY_EDITION = 'cloud'
    delete process.env.BACKENLY_OPEN_REGIONS
    const body = await GET().json()
    expect(body.regions.filter((r: { open: boolean }) => r.open).map((r: { id: string }) => r.id)).toEqual(['ap-south-1'])
  })
})

describe('the platform middleware lets an anonymous caller reach it', () => {
  // The middleware module does not load under jest (ESM-only dependencies), so
  // this reads its source, as tests/unit/runtime-paths-are-routed.spec.ts does.
  // Staging's website checks exercise it for real.
  const src = fs.readFileSync(path.resolve(__dirname, '../../middleware.ts'), 'utf8')
  const exactList = src.match(/const publicApiExactRoutes = \[([\s\S]*?)\]/)?.[1] ?? ''

  it('lists /api/regions as a public API route', () => {
    expect(exactList).toMatch(/^\s*'\/api\/regions',/m)
  })

  it('matches it exactly, so a route added under it later is not public by accident', () => {
    expect(src).toContain('publicApiExactRoutes.includes(pathname)')
    const prefixList = src.match(/const publicApiRoutes = \[([\s\S]*?)\n\]/)?.[1] ?? ''
    expect(prefixList).not.toMatch(/'\/api\/regions/)
  })
})
