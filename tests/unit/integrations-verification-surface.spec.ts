/**
 * The console shows what the provider said about a stored key (INT-13).
 *
 * listKeyVaultStatuses returns verification/verificationDetail, and the key
 * store's own contract warns never to fold them into a boolean "connected".
 * The GET route dropped both fields, so the panel rendered every stored key
 * as a green "Connected"/"Stored" — including keys the provider REJECTED.
 */

import fs from 'fs'
import path from 'path'

const ROOT = process.cwd()
const route = fs.readFileSync(path.join(ROOT, 'app', 'api', 'projects', '[id]', 'integrations', 'route.ts'), 'utf8')
const panel = fs.readFileSync(path.join(ROOT, 'components', 'hub', 'IntegrationsPanel.tsx'), 'utf8')

describe('INT-13: verification state reaches the console', () => {
  it('the GET route forwards verification and its detail', () => {
    expect(route).toContain('verification: ks.verification')
    expect(route).toContain('verificationDetail: ks.verificationDetail')
  })

  it('the panel derives tone and label from the verdict, not a boolean', () => {
    expect(panel).toContain('keyVerificationBadge')
    expect(panel).toContain("case 'rejected'")
    expect(panel).toContain('Key rejected by the provider')
  })

  it('the connection card no longer renders an unconditional green Stored', () => {
    expect(panel).not.toContain('<StatusDot tone="operational" label="Stored" />')
  })

  it('a rejected or unreachable key shows the provider detail', () => {
    expect(panel).toContain('verificationDetail')
  })
})
