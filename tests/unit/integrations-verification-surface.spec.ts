/**
 * The console shows what the provider said about a stored key (INT-13).
 *
 * listKeyVaultStatuses returns verification/verificationDetail, and the key
 * store's own contract warns never to fold them into a boolean "connected".
 * The GET route dropped both fields, so the panel rendered every stored key
 * as a green "Connected"/"Stored" — including keys the provider REJECTED.
 *
 * Since the console rebuild (2026-11-16) the verdict is read in one place,
 * components/hub/integration-state.ts (providerStatus, credentialGlyph), so
 * this checks that module's answers rather than the panel's source text.
 */

import fs from 'fs'
import path from 'path'
import { integrationCatalog } from '@/components/hub/integration-catalog'
import { credentialGlyph, providerStates, providerStatus, type IntegrationsAnswer } from '@/components/hub/integration-state'

const ROOT = process.cwd()
const route = fs.readFileSync(path.join(ROOT, 'app', 'api', 'projects', '[id]', 'integrations', 'route.ts'), 'utf8')
const panel = fs.readFileSync(path.join(ROOT, 'components', 'hub', 'IntegrationsPanel.tsx'), 'utf8')

const resendWith = (verification: string, verificationDetail?: string) => {
  const answer: IntegrationsAnswer = {
    integrations: {},
    keyVault: { resend: { maskedKey: 're_d7a8…9dac', connectedAt: '2026-11-10T00:00:00.000Z', verification, verificationDetail } },
  }
  return providerStates(integrationCatalog(), answer).find((s) => s.provider.id === 'resend')!
}

describe('INT-13: verification state reaches the console', () => {
  it('the GET route forwards verification, its detail and when it was confirmed', () => {
    expect(route).toContain('verification: ks.verification')
    expect(route).toContain('verificationDetail: ks.verificationDetail')
    expect(route).toContain('verifiedAt: ks.verifiedAt')
  })

  it('derives the state from the verdict, not from a stored key', () => {
    expect(providerStatus(resendWith('verified'))).toMatchObject({ glyph: 'live', label: 'Connected' })
    expect(providerStatus(resendWith('rejected', 'Resend refused this key.'))).toMatchObject({ glyph: 'failed', word: 'Key rejected' })
    expect(providerStatus(resendWith('unreachable'))).toMatchObject({ glyph: 'idle', fact: 'Couldn’t reach Resend' })
    expect(providerStatus(resendWith('unverifiable'))).toMatchObject({ glyph: 'idle', fact: 'Format checked only' })
    expect(credentialGlyph({ maskedKey: 'x', connectedAt: '', verification: 'rejected' })).toEqual({ glyph: 'failed', label: 'Rejected' })
  })

  it('the connection row no longer renders an unconditional green Stored', () => {
    expect(panel).not.toContain('<StatusDot tone="operational" label="Stored" />')
  })

  it('a rejected or unreachable key carries the provider detail to the row', () => {
    expect(providerStatus(resendWith('rejected', 'Resend refused this key.')).detail).toBe('Resend refused this key.')
    expect(providerStatus(resendWith('unreachable', 'Resend did not answer.')).detail).toBe('Resend did not answer.')
    expect(panel).toContain('status.detail')
  })
})
