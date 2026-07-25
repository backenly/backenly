import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * The PostgREST control headers must survive a browser preflight.
 *
 * /api/v2 is advertised as PostgREST's grammar passed through untouched, and
 * `Prefer` is how that grammar asks for the created row back
 * (return=representation), an upsert (resolution=merge-duplicates) and a total
 * (count=exact). Omitting it from Access-Control-Allow-Headers does not degrade
 * those features — it removes them from every browser, with a bare
 * `TypeError: Failed to fetch` and nothing naming CORS.
 *
 * Asserted against source rather than a live server because the failure is
 * invisible to Node-based tests: fetch in Node does not enforce CORS at all,
 * so an integration test would have passed throughout the outage.
 */
const ROOT = process.cwd()
const EXPRESS = readFileSync(join(ROOT, 'server/app.ts'), 'utf8')
const NEXT_MW = readFileSync(join(ROOT, 'middleware.ts'), 'utf8')

const REQUIRED_REQUEST_HEADERS = ['Prefer', 'Range', 'Range-Unit']
/** Headers a browser cannot READ unless they are explicitly exposed. */
const REQUIRED_EXPOSED = ['Content-Range']

describe('CORS allows the PostgREST control headers (P0)', () => {
  it.each(REQUIRED_REQUEST_HEADERS)('the Express runtime allows %s', (h) => {
    const block = EXPRESS.slice(EXPRESS.indexOf('allowedHeaders'), EXPRESS.indexOf('exposedHeaders'))
    expect(block).toContain(`'${h}'`)
  })

  it.each(REQUIRED_EXPOSED)('the Express runtime exposes %s so the client can read it', (h) => {
    const block = EXPRESS.slice(EXPRESS.indexOf('exposedHeaders'))
    expect(block.slice(0, 400)).toContain(h)
  })

  it('the Next middleware allows the same headers on SDK routes', () => {
    const line = NEXT_MW.split('\n').find((l) => l.includes('X-User-Token, x-api-key'))
    expect(line).toBeTruthy()
    for (const h of REQUIRED_REQUEST_HEADERS) expect(line).toContain(h)
  })

  it('the Next middleware exposes Content-Range on SDK routes', () => {
    expect(NEXT_MW).toContain('Access-Control-Expose-Headers')
    expect(NEXT_MW).toContain('Content-Range')
  })

  it('both runtimes still allow the two auth headers', () => {
    for (const h of ['x-api-key', 'X-User-Token']) {
      expect(EXPRESS).toContain(`'${h}'`)
      expect(NEXT_MW).toContain(h)
    }
  })
})
