/**
 * ROTATING A PROVIDER SECRET, AND NEVER SERVING IT BACK
 * ====================================================
 *
 * Credential-rotation qualification for the secrets an operator types into the
 * dashboard rather than into a connection string: OAuth client secrets.
 *
 * Two properties, and the second is the one that was broken.
 *
 *   ROTATION   saving a new secret replaces the stored one, and the flow that
 *              uses it picks up the replacement.
 *
 *   OPACITY    a stored secret is never served back. Encrypting at rest and
 *              then decrypting it into a browser response covers only the
 *              database-theft half of the threat model; the secret still ends
 *              up in browser memory, in devtools, and in any HAR capture or
 *              session replay the operator's own tooling makes.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * `WorkspaceOAuthService.listConfigs` decrypted `clientSecret` for every
 * provider, and `GET /api/workspace-oauth` returned that list verbatim. So
 * opening the Auth page shipped every configured provider's plaintext client
 * secret to the browser.
 *
 * The POST on the SAME endpoint already redacted its own response, with the
 * comment "Don't send secret back", so the intent was never in doubt — the GET
 * simply contradicted it. The dashboard reads only `provider` and `enabled`
 * from that response, so nothing needed the secret at all.
 *
 * The OAuth flow is unaffected and that is asserted here too: it uses
 * `getConfig`, which decrypts inside the runtime and never crosses a network.
 * Without that pairing, "the secret is absent" would be equally true of a
 * change that simply broke provider login.
 */

import crypto from 'crypto'
import { PrismaClient } from '@prisma/client'

// Generated per run, never committed. The product REFUSES to encrypt without
// this - deliberately, because a fallback baked into a public repository is a
// key everybody already has - so a suite about secret handling has to supply
// one. A literal here would also be a 32-byte hex string in a public repo, and
// the release scanner is right to object to those.
process.env.OAUTH_ENCRYPTION_KEY =
  process.env.OAUTH_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex')

import { WorkspaceOAuthService } from '@/lib/services/workspaceOAuth'

const prisma = new PrismaClient()

const FIRST_SECRET = `first-oauth-secret-${crypto.randomBytes(8).toString('hex')}`
const ROTATED_SECRET = `rotated-oauth-secret-${crypto.randomBytes(8).toString('hex')}`
const PROVIDER = 'google'

let ownerId: string
let projectId: string

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: {
        email: `oauth-rot-${crypto.randomBytes(5).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'OAuth Rotation Suite',
      },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: 'oauth-rotation', userId: ownerId },
      select: { id: true },
    })
  ).id
}, 180_000)

afterAll(async () => {
  await prisma.workspaceOAuthConfig.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await prisma.$disconnect()
}, 180_000)

describe('a provider secret is stored, rotated, and never served back', () => {
  it('stores the first secret ENCRYPTED, and the flow can still read it', async () => {
    await WorkspaceOAuthService.upsertConfig(projectId, {
      provider: PROVIDER,
      clientId: 'client-id-one',
      clientSecret: FIRST_SECRET,
      enabled: true,
    })

    // At rest: the column must not contain the plaintext.
    const row = await prisma.workspaceOAuthConfig.findFirst({
      where: { projectId, provider: PROVIDER },
      select: { clientSecret: true },
    })
    expect(row).toBeTruthy()
    expect(row!.clientSecret).not.toContain(FIRST_SECRET)

    // CONTROL: the server-side path the OAuth flow uses still resolves it.
    // Without this, every "the secret is absent" assertion below would be
    // equally true of a configuration that simply does not work.
    const forFlow = await WorkspaceOAuthService.getConfig(projectId, PROVIDER)
    expect(forFlow!.clientSecret).toBe(FIRST_SECRET)
  }, 120_000)

  it('does NOT hand the secret to the dashboard listing', async () => {
    const listing = await WorkspaceOAuthService.listConfigs(projectId)
    expect(listing.length).toBe(1)

    // The whole response, serialised, is what the browser receives.
    const serialised = JSON.stringify(listing)
    expect(serialised).not.toContain(FIRST_SECRET)
    // And not merely renamed: the field is gone.
    expect((listing[0] as any).clientSecret).toBeUndefined()

    // What the dashboard actually needs, and all it needs.
    expect(listing[0].provider).toBe(PROVIDER)
    expect(listing[0].enabled).toBe(true)
    expect(listing[0].clientSecretConfigured).toBe(true)
  }, 120_000)

  it('ROTATES: the new secret replaces the old one for the flow', async () => {
    await WorkspaceOAuthService.upsertConfig(projectId, {
      provider: PROVIDER,
      clientId: 'client-id-one',
      clientSecret: ROTATED_SECRET,
      enabled: true,
    })

    const forFlow = await WorkspaceOAuthService.getConfig(projectId, PROVIDER)
    expect(forFlow!.clientSecret).toBe(ROTATED_SECRET)
    // The old one is genuinely gone, not merely shadowed.
    expect(forFlow!.clientSecret).not.toBe(FIRST_SECRET)

    const row = await prisma.workspaceOAuthConfig.findFirst({
      where: { projectId, provider: PROVIDER },
      select: { clientSecret: true },
    })
    expect(row!.clientSecret).not.toContain(ROTATED_SECRET)
    expect(row!.clientSecret).not.toContain(FIRST_SECRET)
  }, 120_000)

  it('still does not serve the ROTATED secret back either', async () => {
    const serialised = JSON.stringify(await WorkspaceOAuthService.listConfigs(projectId))
    expect(serialised).not.toContain(ROTATED_SECRET)
    expect(serialised).not.toContain(FIRST_SECRET)
  }, 120_000)
})
