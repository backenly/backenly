/**
 * THE CONNECT PAGE POINTS AGENTS AT THIS DEPLOYMENT, NOT AT BACKENLY CLOUD
 * ========================================================================
 * Every install command on the Connect page was built from a hardcoded
 * `https://backenly.com`: a self-hosted operator pasted the one-command
 * install, their agent connected to Backenly Cloud, Cloud answered
 * INVALID_KEY (the key was minted by the self-host), and the stdio package
 * exited — the first-run experience was broken for exactly the audience that
 * cannot fall back to the hosted product. The same hardcoding sat in the CLI
 * overview's `apiBase`, the OpenAPI `serverUrl` and `get_instructions`.
 *
 * Pinned here:
 *   - the origin comes from the browser when there is one, else from
 *     NEXT_PUBLIC_APP_URL, and only then falls back to backenly.com
 *   - the stdio command gains `--endpoint <origin>` exactly when the origin
 *     is not Backenly Cloud, so Cloud commands are byte-identical to before
 *   - the remote URL is `<origin>/api/mcp`
 */

import { dashboardOrigin, remoteUrl, NPX_ARGS } from '@/components/connect/AgentInstallGuide'

const ORIGINAL_ENV = process.env.NEXT_PUBLIC_APP_URL

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_ENV
  delete (global as any).window
})

describe('dashboardOrigin', () => {
  it('uses the browser origin when there is one', () => {
    ;(global as any).window = { location: { origin: 'https://backend.acme.dev' } }
    expect(dashboardOrigin()).toBe('https://backend.acme.dev')
    expect(remoteUrl()).toBe('https://backend.acme.dev/api/mcp')
  })

  it('falls back to NEXT_PUBLIC_APP_URL during prerender', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000/'
    expect(dashboardOrigin()).toBe('http://localhost:3000')
  })

  it('defaults to Backenly Cloud only when nothing else is known', () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    expect(dashboardOrigin()).toBe('https://backenly.com')
  })
})

describe('the stdio install command', () => {
  it('is byte-identical to before on Backenly Cloud', () => {
    ;(global as any).window = { location: { origin: 'https://backenly.com' } }
    expect(NPX_ARGS('proj-1', 'mcp_live_k')).toEqual([
      '-y', '@backenly/mcp-server', '--project', 'proj-1', '--key', 'mcp_live_k',
    ])
  })

  it('names the self-host endpoint everywhere else', () => {
    ;(global as any).window = { location: { origin: 'https://backend.acme.dev' } }
    expect(NPX_ARGS('proj-1', 'mcp_live_k')).toEqual([
      '-y', '@backenly/mcp-server', '--project', 'proj-1', '--key', 'mcp_live_k',
      '--endpoint', 'https://backend.acme.dev',
    ])
  })
})
