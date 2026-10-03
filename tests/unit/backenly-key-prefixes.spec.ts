/**
 * New Backenly keys never look like a Stripe secret.
 *
 * The dashboard key route, key rotation and every project's default key minted
 * `sk_live_` / `sk_test_`, Stripe's secret-key format, while the rest of the
 * product treats that prefix as Stripe's: the chat files a pasted `sk_live_…`
 * as a Stripe integration key. Keys already issued keep working, since
 * authentication is by hash; only what is minted from now on changes.
 */

import fs from 'fs'
import path from 'path'
import {
  ISSUED_PREFIX,
  LEGACY_PREFIXES,
  issuedKeyPrefix,
  looksLikeBackenlyKey,
  mintKey,
} from '@/lib/auth/key-prefix'
import { detectApiKey } from '@/lib/ai/api-key-detector'
import { classifyKeyFailure } from '@/lib/middleware/apiKeyFailureDiagnostic'

const STRIPE_LIKE = /^(sk|rk|pk)_/

describe('what a new key is called', () => {
  it('takes its prefix from what the key is, never from its role', () => {
    expect(issuedKeyPrefix({ serviceRole: false })).toBe('proj_live_')
    expect(issuedKeyPrefix({ serviceRole: true })).toBe('svc_live_')
    expect(issuedKeyPrefix({ scope: 'mcp' })).toBe('mcp_live_')
    expect(issuedKeyPrefix({ keyType: 'dashboard', serviceRole: true })).toBe('dk_admin_')
  })

  it('never issues a Stripe-shaped prefix', () => {
    expect(Object.values(ISSUED_PREFIX).filter((p) => STRIPE_LIKE.test(p))).toEqual([])
  })

  it('mints hex after the prefix, which is how a Backenly key is told apart', () => {
    const { key, prefix } = mintKey({ serviceRole: true })
    expect(key).toMatch(/^svc_live_[0-9a-f]{64}$/)
    expect(prefix).toBe('svc_live_')
    expect(looksLikeBackenlyKey(key)).toBe(true)
  })

  it('rotates a legacy key into the current prefix of the same kind', () => {
    expect(mintKey({ keyType: 'public', scope: 'runtime', serviceRole: false }).key.startsWith('proj_live_')).toBe(true)
    expect(mintKey({ keyType: 'public', scope: 'mcp', serviceRole: false }).key.startsWith('mcp_live_')).toBe(true)
  })
})

describe('telling a Backenly key from a provider secret', () => {
  const legacy = `sk_live_${'ab'.repeat(32)}`
  // Shaped like a Stripe secret (sk_live_ and not hex) without looking like a real one.
  const stripe = 'sk_live_NOT_A_REAL_KEY'

  it('recognises every current and legacy Backenly shape', () => {
    for (const prefix of [...Object.values(ISSUED_PREFIX), ...LEGACY_PREFIXES]) {
      expect({ prefix, ok: looksLikeBackenlyKey(`${prefix}${'0f'.repeat(24)}`) }).toEqual({ prefix, ok: true })
    }
  })

  it('does not mistake a Stripe secret for one', () => {
    expect(looksLikeBackenlyKey(stripe)).toBe(false)
  })

  it('does not file a new Backenly key as a Stripe key when it is pasted into chat', () => {
    for (const serviceRole of [false, true]) {
      const { key } = mintKey({ serviceRole })
      expect(detectApiKey(`here is my key ${key}`)?.integrationId ?? null).not.toBe('stripe')
    }
  })

  it('does not tell the holder of a service-role or MCP key that it has the wrong format', () => {
    for (const kind of [{ serviceRole: true }, { scope: 'mcp' }]) {
      const d = classifyKeyFailure(mintKey(kind).key, 'unknown_key')
      expect(d.kind).not.toBe('malformed')
    }
  })

  it('still names a Stripe secret sent in its place, and a legacy key is still a Backenly shape', () => {
    const d = classifyKeyFailure(stripe, 'unknown_key')
    expect(d.kind).toBe('malformed')
    expect(d.hint).toContain('Stripe')
    expect(classifyKeyFailure(legacy, 'unknown_key').kind).not.toBe('malformed')
  })
})

describe('the source', () => {
  it('mints no key with a legacy prefix anywhere', () => {
    const roots = ['lib', 'app', 'server']
    const minting = /`(sk_(?:live|test|read|ai|client|service)_)\$\{/
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue }
        if (!/\.(ts|tsx)$/.test(e.name)) continue
        if (minting.test(fs.readFileSync(p, 'utf8'))) offenders.push(p.replace(/\\/g, '/'))
      }
    }
    for (const r of roots) if (fs.existsSync(r)) walk(r)
    expect(offenders).toEqual([])
  })

  it('issues MCP keys with the prefix this module names', () => {
    const route = fs.readFileSync('app/api/projects/[id]/mcp/keys/route.ts', 'utf8')
    expect(route).toContain(`\`${ISSUED_PREFIX.mcp}\${`)
  })
})
