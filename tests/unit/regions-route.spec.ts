/**
 * GET /api/regions: the region picker's source for what customers may choose
 * on the running deployment (lib/regions.ts, BACKENLY_OPEN_REGIONS).
 *
 *   - a self-hosted deployment has no regions, so the route does not exist;
 *   - on Cloud it lists the five regions, each with `open` as this deployment
 *     serves it, and nothing else: no per-account preview or staging regions.
 */

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
