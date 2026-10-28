/**
 * THE OAUTH CONSENT PAGE IS REACHABLE ON A SELF-HOSTED INSTALL
 * ============================================================
 * Off Cloud, the middleware bounces marketing paths to /app — and '/mcp' is a
 * marketing prefix, so the OSS OAuth flow died at its last step: the install
 * serves the 401 challenge and the OAuth metadata, the agent's host opens the
 * browser at /mcp/authorize?req=..., and the middleware 302'd it to /app. The
 * dashboard opened, no authorization code was ever minted, and the host waited
 * on a callback that never came.
 *
 * /mcp/authorize is now exempt (the consent page is product, not marketing),
 * while /mcp itself still bounces. The consent page also lists projects
 * through the edition resolver, because a self-host bootstrap project has
 * Project.userId = NULL and the old owner-only filter showed the operator
 * "No projects yet" on the one page that mints the code.
 */

import '@/tests/helpers/real-web-standard'
import { readFileSync } from 'fs'
import { join } from 'path'

// `jose` ships ESM-only and jest cannot parse it; the marketing-path decision
// under test runs long before any JWT is verified, so a stub is faithful here.
jest.mock('jose', () => ({ jwtVerify: jest.fn(async () => ({ payload: {} })) }))

import { NextRequest } from 'next/server'
import { middleware } from '@/middleware'
import { CLOUD_CONTROL_PLANE } from '@/lib/edition/oss/control-plane'

async function runMiddleware(path: string) {
  // The host header must be present: without it the custom-domain router
  // treats the request as an unknown domain and 404s before the marketing
  // rule under test is ever reached.
  const req = new NextRequest(`http://localhost:3000${path}`, {
    headers: { host: 'localhost:3000' },
  })
  return middleware(req)
}

describe('on a self-hosted install (CLOUD_CONTROL_PLANE=false in the public tree)', () => {
  it('this tree is the OSS edition, or these assertions prove nothing', () => {
    expect(CLOUD_CONTROL_PLANE).toBe(false)
  })

  it('/mcp/authorize is not bounced to /app', async () => {
    const res = await runMiddleware('/mcp/authorize?req=abc')
    const location = res?.headers.get('location') ?? ''
    expect(new URL(location || 'http://localhost:3000/stay', 'http://localhost:3000').pathname).not.toBe('/app')
  })

  it('/mcp (the marketing page) still goes to the product', async () => {
    const res = await runMiddleware('/mcp')
    const location = res?.headers.get('location') ?? ''
    expect(new URL(location, 'http://localhost:3000').pathname).toBe('/app')
  })
})

describe('the consent page lists projects the signed-in operator can actually use', () => {
  const page = readFileSync(join(process.cwd(), 'app/mcp/authorize/page.tsx'), 'utf8')

  it('queries through the edition resolver, not a raw owner filter', () => {
    expect(page).toContain('accessibleProjectsWhere')
    // The old filter: a bootstrap project has userId NULL, so this showed
    // "No projects yet" on every fresh self-host install.
    expect(page).not.toMatch(/where:\s*\{\s*userId:/)
  })
})
