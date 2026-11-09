/**
 * Which keys are admin keys bound by row-level security, and what a browser
 * gets from one: served (and recorded) until ADMIN_KEYS_SERVER_ONLY_FROM,
 * refused from then on (lib/security/admin-key-placement.ts). What a key is,
 * in the words developers choose keys by (lib/auth/key-prefix.ts keyKind).
 */

import { adminKeyInBrowser, adminKeysServerOnlyFrom, isRlsBoundAdminKey } from '@/lib/security/admin-key-placement'
import { keyKind } from '@/lib/auth/key-prefix'
import type { BrowserOriginVerdict } from '@/lib/security/service-role-exposure'

const browser: BrowserOriginVerdict = { isBrowser: true, signal: 'sec_fetch', origin: 'https://shop.example.test' }
const server: BrowserOriginVerdict = { isBrowser: false, signal: null, origin: null }
// No project: nothing is recorded, so this stays free of the database.
const key = { id: 'k1', name: 'Shop Default Key', keyPrefix: 'proj_live_ab12', projectId: null }
const request = { method: 'GET', path: '/api/v1/p/storage/files' }

afterEach(() => {
  delete process.env.ADMIN_KEYS_SERVER_ONLY_FROM
})

describe('isRlsBoundAdminKey', () => {
  it('is an admin-role key that is not a service, dashboard or MCP key', () => {
    expect(isRlsBoundAdminKey({ role: 'admin', serviceRole: false, keyType: 'public', scope: 'runtime' })).toBe(true)
    expect(isRlsBoundAdminKey({ role: 'admin', serviceRole: true, keyType: 'public' })).toBe(false)
    expect(isRlsBoundAdminKey({ role: 'admin', serviceRole: false, keyType: 'dashboard' })).toBe(false)
    expect(isRlsBoundAdminKey({ role: 'admin', serviceRole: false, keyType: 'public', scope: 'mcp' })).toBe(false)
    expect(isRlsBoundAdminKey({ role: 'client', serviceRole: false, keyType: 'public' })).toBe(false)
  })
})

describe('adminKeyInBrowser', () => {
  it('serves a browser until a date is set', () => {
    expect(adminKeysServerOnlyFrom()).toBeNull()
    expect(adminKeyInBrowser(key, browser, request)).toBeNull()
  })

  it('serves a browser before the date, and refuses it from the date on', () => {
    process.env.ADMIN_KEYS_SERVER_ONLY_FROM = '2026-12-01T00:00:00Z'
    expect(adminKeyInBrowser(key, browser, request, new Date('2026-11-30T23:59:59Z'))).toBeNull()
    const refused = adminKeyInBrowser(key, browser, request, new Date('2026-12-01T00:00:00Z'))
    expect(refused?.message).toContain('"Shop Default Key" has the admin role')
    expect(refused?.message).toContain('never answers a browser')
  })

  it('always serves a server', () => {
    process.env.ADMIN_KEYS_SERVER_ONLY_FROM = '2020-01-01T00:00:00Z'
    expect(adminKeyInBrowser(key, server, request)).toBeNull()
  })

  it('ignores a date it cannot read rather than refusing on it', () => {
    process.env.ADMIN_KEYS_SERVER_ONLY_FROM = 'next tuesday'
    expect(adminKeysServerOnlyFrom()).toBeNull()
    expect(adminKeyInBrowser(key, browser, request)).toBeNull()
  })
})

describe('keyKind', () => {
  it('names a key by what it is, not by keyType', () => {
    expect(keyKind({ keyType: 'public', role: 'client', serviceRole: false })).toBe('publishable')
    expect(keyKind({ keyType: 'public', role: 'admin', serviceRole: true })).toBe('service')
    expect(keyKind({ keyType: 'public', role: 'admin', serviceRole: false })).toBe('server')
    expect(keyKind({ keyType: 'mcp', scope: 'mcp', serviceRole: true })).toBe('mcp')
    expect(keyKind({ keyType: 'dashboard', role: 'admin' })).toBe('dashboard')
  })
})
