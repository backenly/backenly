/**
 * Firebase Authentication users → Backenly end users.
 *
 *   GET  identitytoolkit /admin/v2/projects/{p}/config        signIn.hashConfig: the
 *        project's password hash parameters (needs firebaseauth.configs.getHashConfig,
 *        in the Firebase Authentication Admin role)
 *   GET  identitytoolkit /v1/projects/{p}/accounts:batchGet    users, 1,000 a page
 *   POST identitytoolkit /v1/projects/{p}/accounts:query       { returnUserInfo: false }:
 *        how many there are, when the preview stops paging
 *
 * A user with an email and a Firebase password hash keeps signing in with the
 * same password: the hash is stored with the project's parameters behind a
 * scheme marker (lib/auth/firebase-scrypt.ts) and replaced with bcrypt on the
 * first sign-in. A user who signed in with Google, GitHub and the like arrives
 * with that identity (oauth_provider, oauth_id), and Backenly's own provider
 * sign-in links them by email once the provider is set up. Phone-only and
 * anonymous users have no email to sign in with, so they are counted in the
 * warnings and not moved.
 */

import { encodeFirebaseHash, firebaseParamsProblem, type FirebaseHashParams } from '@/lib/auth/firebase-scrypt'
import { GoogleApiError, type GoogleClient } from '../google-http'

const ITK = 'https://identitytoolkit.googleapis.com'

/** What Identity Toolkit returns for a hash it will not show this caller: base64 of "REDACTED". */
const REDACTED = Buffer.from('REDACTED').toString('base64')

export interface FirebaseProviderInfo {
  providerId?: string
  rawId?: string
  federatedId?: string
  email?: string
  displayName?: string
  photoUrl?: string
  phoneNumber?: string
}

export interface FirebaseUser {
  localId: string
  email?: string
  emailVerified?: boolean
  displayName?: string
  photoUrl?: string
  passwordHash?: string
  salt?: string
  disabled?: boolean
  createdAt?: string
  lastLoginAt?: string
  phoneNumber?: string
  customAttributes?: string
  emailLinkSignin?: boolean
  providerUserInfo?: FirebaseProviderInfo[]
  tenantId?: string
}

export interface HashSettings {
  params: FirebaseHashParams | null
  /** Why passwords cannot move, in plain words; null when they can. */
  problem: string | null
}

/** The project's password hash parameters, or why they cannot be had. */
export async function readHashSettings(client: GoogleClient, projectId: string): Promise<HashSettings> {
  let config: any
  try {
    config = await client.json('auth', 'auth', 'GET', `${ITK}/admin/v2/projects/${encodeURIComponent(projectId)}/config`)
  } catch (err) {
    if (err instanceof GoogleApiError && (err.status === 403 || err.status === 404)) {
      return {
        params: null,
        problem: err.serviceDisabled
          ? 'Firebase Authentication is turned off for this project.'
          : "This key can't read the password hash settings. Give the service account the Firebase Authentication Admin role.",
      }
    }
    throw err
  }
  const hc = config?.signIn?.hashConfig
  if (!hc || !hc.signerKey) {
    return {
      params: null,
      problem: "This key can't read the password hash settings. Give the service account the Firebase Authentication Admin role.",
    }
  }
  if (hc.algorithm && hc.algorithm !== 'SCRYPT') {
    return { params: null, problem: `This project hashes passwords with ${hc.algorithm}, which Backenly can't check yet.` }
  }
  const params: FirebaseHashParams = {
    signerKey: String(hc.signerKey),
    saltSeparator: typeof hc.saltSeparator === 'string' ? hc.saltSeparator : '',
    rounds: Number(hc.rounds),
    memoryCost: Number(hc.memoryCost),
  }
  const problem = firebaseParamsProblem(params)
  return problem ? { params: null, problem } : { params, problem: null }
}

/** One page of users. */
export async function listUsersPage(
  client: GoogleClient,
  projectId: string,
  pageToken?: string,
  pageSize = 1000,
): Promise<{ users: FirebaseUser[]; nextPageToken?: string }> {
  const q = new URLSearchParams({ maxResults: String(pageSize) })
  if (pageToken) q.set('nextPageToken', pageToken)
  const res = await client.json<{ users?: FirebaseUser[]; nextPageToken?: string }>(
    'auth', 'auth', 'GET',
    `${ITK}/v1/projects/${encodeURIComponent(projectId)}/accounts:batchGet?${q.toString()}`,
  )
  return { users: res.users ?? [], nextPageToken: res.nextPageToken || undefined }
}

/** Every user, page by page. */
export async function* listUsers(client: GoogleClient, projectId: string): AsyncGenerator<FirebaseUser[]> {
  let token: string | undefined
  do {
    const page = await listUsersPage(client, projectId, token)
    if (page.users.length) yield page.users
    token = page.nextPageToken
  } while (token)
}

/** How many users the project has, without reading them; null when Google will not say. */
export async function countUsers(client: GoogleClient, projectId: string): Promise<number | null> {
  try {
    const res = await client.json<{ recordsCount?: string }>(
      'auth', 'auth', 'POST',
      `${ITK}/v1/projects/${encodeURIComponent(projectId)}/accounts:query`,
      { returnUserInfo: false },
    )
    const n = Number(res.recordsCount)
    return Number.isFinite(n) ? n : null
  } catch (err) {
    if (err instanceof GoogleApiError && err.permissionDenied) throw err
    return null
  }
}

// ── Mapping ────────────────────────────────────────────────────────────────────

/** Firebase provider ids → the names Backenly's provider sign-in uses (server/routes/oauth.ts). */
const PROVIDERS: Record<string, string> = {
  'google.com': 'google',
  'github.com': 'github',
  'facebook.com': 'facebook',
  'twitter.com': 'twitter',
  'apple.com': 'apple',
  'microsoft.com': 'microsoft',
  'yahoo.com': 'yahoo',
  'gc.apple.com': 'game_center',
  'playgames.google.com': 'play_games',
}

/** Providers Backenly can sign a person in with today. */
export const BACKENLY_PROVIDERS = new Set(['google', 'github', 'facebook', 'discord'])

const PREFERRED = ['google', 'github', 'facebook']

/** A Backenly end-user row, before it is written. */
export interface ImportedUser {
  email: string
  name: string | null
  emailVerified: boolean
  disabled: boolean
  createdAt: Date | null
  lastLoginAt: Date | null
  avatarUrl: string | null
  oauthProvider: string | null
  oauthId: string | null
  firebaseUid: string
  /** The stored Firebase hash ($firebase-scrypt$…), or null. */
  password: string | null
}

export type UserOutcome =
  | { kind: 'imported'; user: ImportedUser; sort: 'password' | 'provider' | 'reset'; providers: string[] }
  | { kind: 'skipped'; reason: 'phone' | 'anonymous' | 'no_email' }

function millis(v: unknown): Date | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? new Date(n) : null
}

function federated(u: FirebaseUser): FirebaseProviderInfo[] {
  return (u.providerUserInfo ?? []).filter((p) => p.providerId && p.providerId !== 'password' && p.providerId !== 'phone')
}

export function providerName(providerId: string): string {
  return PROVIDERS[providerId] ?? providerId.replace(/[^a-z0-9._-]/gi, '_').toLowerCase()
}

/**
 * What one Firebase user becomes. `hash` is the project's parameters when
 * passwords can move, null when they cannot (a user with a password then
 * arrives without one and resets it).
 */
export function mapFirebaseUser(u: FirebaseUser, hash: FirebaseHashParams | null): UserOutcome {
  const providers = federated(u)
  const email = (u.email || providers.find((p) => p.email)?.email || '').trim()
  if (!email) {
    if (u.phoneNumber || (u.providerUserInfo ?? []).some((p) => p.providerId === 'phone')) return { kind: 'skipped', reason: 'phone' }
    if (providers.length === 0) return { kind: 'skipped', reason: 'anonymous' }
    return { kind: 'skipped', reason: 'no_email' }
  }

  const names = providers.map((p) => providerName(String(p.providerId)))
  const preferredIndex = PREFERRED.map((n) => names.indexOf(n)).find((i) => i >= 0)
  const chosen = providers[preferredIndex ?? 0]

  const hasHash = typeof u.passwordHash === 'string' && u.passwordHash !== '' && u.passwordHash !== REDACTED
  const password = hasHash && hash && u.salt !== undefined
    ? encodeFirebaseHash(hash, { salt: u.salt, passwordHash: u.passwordHash! })
    : null
  // An email-link account lists the password provider without ever having had
  // a password; it signs in with Backenly's magic links as it did with Firebase's.
  const hadPassword = hasHash || (!u.emailLinkSignin && (u.providerUserInfo ?? []).some((p) => p.providerId === 'password'))

  const user: ImportedUser = {
    email,
    name: u.displayName?.trim() || chosen?.displayName?.trim() || null,
    emailVerified: u.emailVerified === true,
    disabled: u.disabled === true,
    createdAt: millis(u.createdAt),
    lastLoginAt: millis(u.lastLoginAt),
    avatarUrl: u.photoUrl || chosen?.photoUrl || null,
    oauthProvider: chosen ? providerName(String(chosen.providerId)) : null,
    oauthId: chosen ? (chosen.rawId || chosen.federatedId || null) : null,
    firebaseUid: u.localId,
    password,
  }
  const sort = password ? 'password' : hadPassword ? 'reset' : 'provider'
  return { kind: 'imported', user, sort, providers: names }
}

/** Running totals while users are read, for the preview and the import's warnings. */
export class UserTally {
  total = 0
  withPassword = 0
  providerOnly = 0
  /** Had a password that could not move: they reset it. */
  needReset = 0
  phone = 0
  anonymous = 0
  noEmail = 0
  customClaims = 0
  unsupported = new Map<string, number>()

  add(u: FirebaseUser, outcome: UserOutcome): void {
    this.total++
    if (outcome.kind === 'skipped') {
      if (outcome.reason === 'phone') this.phone++
      else if (outcome.reason === 'anonymous') this.anonymous++
      else this.noEmail++
      return
    }
    if (outcome.sort === 'password') this.withPassword++
    else if (outcome.sort === 'reset') this.needReset++
    else this.providerOnly++
    if (u.customAttributes && u.customAttributes !== '{}') this.customClaims++
    if (outcome.sort === 'provider') {
      for (const p of outcome.providers) {
        if (!BACKENLY_PROVIDERS.has(p)) this.unsupported.set(p, (this.unsupported.get(p) ?? 0) + 1)
      }
    }
  }

  get skipped(): number {
    return this.phone + this.anonymous + this.noEmail
  }

  /** What does not move, in plain words. */
  warnings(hashProblem: string | null): string[] {
    const out: string[] = []
    const n = (x: number, one: string, many: string) => `${x.toLocaleString('en-US')} ${x === 1 ? one : many}`
    if (this.phone) out.push(`${n(this.phone, 'user signs', 'users sign')} in only with a phone number, so ${this.phone === 1 ? 'it is' : 'they are'} not moved.`)
    if (this.anonymous) out.push(`${n(this.anonymous, 'anonymous user is', 'anonymous users are')} not moved.`)
    if (this.noEmail) out.push(`${n(this.noEmail, 'user has', 'users have')} no email address, so ${this.noEmail === 1 ? 'it is' : 'they are'} not moved.`)
    if (this.needReset) {
      out.push(`${n(this.needReset, 'user', 'users')} will need to reset ${this.needReset === 1 ? 'their password' : 'their passwords'}: ${hashProblem ?? 'their password hashes could not be read.'}`)
    }
    for (const [provider, count] of this.unsupported) {
      out.push(`${n(count, 'user signs', 'users sign')} in with ${provider}, which Backenly doesn't offer yet; ${count === 1 ? 'that user' : 'they'} can set a password with a reset email.`)
    }
    if (this.customClaims) out.push(`Custom claims on ${n(this.customClaims, 'user', 'users')} are not moved.`)
    return out
  }
}
