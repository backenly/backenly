/**
 * Firebase Authentication users → Backenly end users
 * (lib/import/drivers/firebase-users.ts): the project's password hash
 * parameters from Identity Toolkit's admin config, users paged with
 * accounts:batchGet, and what each kind of user becomes. The accounts are
 * shaped as batchGet returns them (url-safe base64 hashes, epoch millis as
 * strings); user1@test.com is the exported account of github.com/firebase/scrypt,
 * so its stored hash is checked against its real password. Database-free.
 */

import { GoogleClient } from '@/lib/import/google-http'
import { GoogleTokenSource, parseServiceAccount } from '@/lib/import/google-auth'
import { verifyFirebaseHash } from '@/lib/auth/firebase-scrypt'
import {
  UserTally,
  countUsers,
  listUsers,
  mapFirebaseUser,
  readHashSettings,
  type FirebaseUser,
} from '@/lib/import/drivers/firebase-users'
import { FakeGoogle, makeServiceAccount } from '../../tests/helpers/fake-google'

const SA = makeServiceAccount('demo-shop')
const noSleep = async () => {}

/** signIn.hashConfig as GET /admin/v2/projects/{p}/config returns it (the README's sample project). */
const HASH_CONFIG = {
  algorithm: 'SCRYPT',
  signerKey: 'jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==',
  saltSeparator: 'Bw==',
  rounds: 8,
  memoryCost: 14,
}

/** Accounts as accounts:batchGet returns them. */
const USERS: FirebaseUser[] = [
  {
    localId: 'kYi4EvWQlQTKSfnJ3dRSP6IH3ed2',
    email: 'user1@test.com',
    displayName: 'Test User 1',
    passwordHash: 'lSrfV15cpx95_sZS2W9c9Kp6i_LVgQNDNC_qzrCnh1SAyZvqmZqAjTdn3aoItz-VHjoZilo78198JAdRuid5lQ==',
    salt: '42xEC-ixf3L2lw==',
    emailVerified: true,
    providerUserInfo: [{ providerId: 'password', email: 'user1@test.com', federatedId: 'user1@test.com', rawId: 'user1@test.com', displayName: 'Test User 1' }],
    createdAt: '1508893925000',
    lastLoginAt: '1508893925000',
  },
  {
    localId: 'G00gl3Us3r0000000000000001',
    email: 'grace@example.com',
    emailVerified: true,
    displayName: 'Grace',
    photoUrl: 'https://lh3.googleusercontent.com/a/photo',
    providerUserInfo: [
      { providerId: 'google.com', rawId: '108765432109876543210', federatedId: '108765432109876543210', email: 'grace@example.com', displayName: 'Grace', photoUrl: 'https://lh3.googleusercontent.com/a/photo' },
    ],
    createdAt: '1700000000000',
    lastLoginAt: '1700000500000',
  },
  {
    localId: 'Ph0n30nly000000000000000001',
    phoneNumber: '+15555550123',
    providerUserInfo: [{ providerId: 'phone', rawId: '+15555550123', phoneNumber: '+15555550123' }],
    createdAt: '1700000000000',
  },
  { localId: 'An0nym0us0000000000000000001', createdAt: '1700000000000' },
  {
    localId: 'L1nkUs3r00000000000000000001',
    email: 'link@example.com',
    emailVerified: true,
    emailLinkSignin: true,
    providerUserInfo: [{ providerId: 'password', email: 'link@example.com', rawId: 'link@example.com' }],
    createdAt: '1700000000000',
  },
  {
    localId: 'D1sabl3d000000000000000000001',
    email: 'banned@example.com',
    disabled: true,
    passwordHash: 'UklEQUNURUQ=', // what batchGet sends a caller who may not read hashes: base64 of "REDACTED"
    salt: 'UklEQUNURUQ=',
    providerUserInfo: [{ providerId: 'password', email: 'banned@example.com', rawId: 'banned@example.com' }],
    createdAt: '1700000000000',
    customAttributes: '{"admin":true}',
  },
  {
    localId: 'Appl3Us3r000000000000000001',
    email: 'apple@example.com',
    providerUserInfo: [{ providerId: 'apple.com', rawId: '001234.abcdef', email: 'apple@example.com' }],
    createdAt: '1700000000000',
  },
]

function clientFor(google: FakeGoogle) {
  const tokens = new GoogleTokenSource(parseServiceAccount(SA.json), { transport: google.transport, sleep: noSleep })
  return new GoogleClient({ token: tokens.token, transport: google.transport, sleep: noSleep })
}

describe('password hash parameters', () => {
  it('reads them from the admin config', async () => {
    const g = new FakeGoogle(SA)
    g.hashConfig = HASH_CONFIG
    const settings = await readHashSettings(clientFor(g), SA.projectId)
    expect(settings).toEqual({
      params: { signerKey: HASH_CONFIG.signerKey, saltSeparator: 'Bw==', rounds: 8, memoryCost: 14 },
      problem: null,
    })
    expect(g.scopesIssued).toEqual(['https://www.googleapis.com/auth/cloud-platform'])
  })

  it('says why passwords cannot move when the key may not read them', async () => {
    const g = new FakeGoogle(SA)
    g.hashConfig = null // Firebase leaves hashConfig out without firebaseauth.configs.getHashConfig
    expect((await readHashSettings(clientFor(g), SA.projectId)).problem).toBe(
      "This key can't read the password hash settings. Give the service account the Firebase Authentication Admin role.",
    )
    g.deny.add('auth')
    expect((await readHashSettings(clientFor(g), SA.projectId)).problem).toBe(
      "This key can't read the password hash settings. Give the service account the Firebase Authentication Admin role.",
    )
  })

  it('refuses an algorithm it cannot check', async () => {
    const g = new FakeGoogle(SA)
    g.hashConfig = { ...HASH_CONFIG, algorithm: 'HMAC_SHA256' }
    expect((await readHashSettings(clientFor(g), SA.projectId)).problem).toBe("This project hashes passwords with HMAC_SHA256, which Backenly can't check yet.")
  })
})

describe('users', () => {
  it('pages through every user and counts them', async () => {
    const g = new FakeGoogle(SA)
    g.users = USERS
    const client = clientFor(g)
    const pages: string[][] = []
    for await (const page of listUsers(client, SA.projectId)) pages.push(page.map((u) => u.localId))
    expect(pages.map((p) => p.length)).toEqual([3, 3, 1])
    expect(pages.flat()).toEqual(USERS.map((u) => u.localId))
    const batchGets = g.calls.filter((c) => c.url.includes('accounts:batchGet'))
    expect(new URL(batchGets[0].url).searchParams.get('maxResults')).toBe('1000')
    expect(new URL(batchGets[1].url).searchParams.get('nextPageToken')).toBeTruthy()
    expect(await countUsers(client, SA.projectId)).toBe(7)
  })

  it('keeps a password user signing in with the same password', async () => {
    const out = mapFirebaseUser(USERS[0], HASH_CONFIG)
    expect(out.kind).toBe('imported')
    if (out.kind !== 'imported') return
    expect(out.sort).toBe('password')
    expect(out.user).toMatchObject({
      email: 'user1@test.com',
      name: 'Test User 1',
      emailVerified: true,
      disabled: false,
      firebaseUid: 'kYi4EvWQlQTKSfnJ3dRSP6IH3ed2',
      oauthProvider: null,
      oauthId: null,
    })
    expect(out.user.createdAt!.toISOString()).toBe('2017-10-25T01:12:05.000Z')
    expect(out.user.password!.startsWith('$firebase-scrypt$v=1$mem=14,rounds=8$')).toBe(true)
    await expect(verifyFirebaseHash('user1password', out.user.password!)).resolves.toBe(true)
    await expect(verifyFirebaseHash('not-it', out.user.password!)).resolves.toBe(false)
  })

  it('moves a provider user with the identity Backenly links on', () => {
    const out = mapFirebaseUser(USERS[1], HASH_CONFIG)
    expect(out).toMatchObject({
      kind: 'imported',
      sort: 'provider',
      user: { email: 'grace@example.com', oauthProvider: 'google', oauthId: '108765432109876543210', avatarUrl: 'https://lh3.googleusercontent.com/a/photo', password: null },
    })
  })

  it('does not move phone-only or anonymous users', () => {
    expect(mapFirebaseUser(USERS[2], HASH_CONFIG)).toEqual({ kind: 'skipped', reason: 'phone' })
    expect(mapFirebaseUser(USERS[3], HASH_CONFIG)).toEqual({ kind: 'skipped', reason: 'anonymous' })
  })

  it('moves an email-link user as one who signs in by email, and a blocked user blocked', () => {
    expect(mapFirebaseUser(USERS[4], HASH_CONFIG)).toMatchObject({ kind: 'imported', sort: 'provider', user: { password: null } })
    // Its hash was redacted: it arrives without one and resets its password.
    expect(mapFirebaseUser(USERS[5], HASH_CONFIG)).toMatchObject({ kind: 'imported', sort: 'reset', user: { disabled: true, password: null } })
  })

  it('without the hash parameters, a password user arrives without a password', () => {
    expect(mapFirebaseUser(USERS[0], null)).toMatchObject({ kind: 'imported', sort: 'reset', user: { password: null } })
  })

  it('totals what moves and says what does not', () => {
    const tally = new UserTally()
    for (const u of USERS) tally.add(u, mapFirebaseUser(u, HASH_CONFIG))
    expect({ total: tally.total, withPassword: tally.withPassword, providerOnly: tally.providerOnly, skipped: tally.skipped, needReset: tally.needReset }).toEqual({
      total: 7,
      withPassword: 1,
      providerOnly: 3,
      skipped: 2,
      needReset: 1,
    })
    expect(tally.warnings("This key can't read the password hash settings.")).toEqual([
      '1 user signs in only with a phone number, so it is not moved.',
      '1 anonymous user is not moved.',
      "1 user will need to reset their password: This key can't read the password hash settings.",
      "1 user signs in with apple, which Backenly doesn't offer yet; that user can set a password with a reset email.",
      'Custom claims on 1 user are not moved.',
    ])
  })
})
