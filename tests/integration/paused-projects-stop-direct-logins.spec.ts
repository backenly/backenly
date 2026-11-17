/**
 * PAUSING OR DELETING A PROJECT STOPS ITS DIRECT POSTGRES LOGINS
 * ==============================================================
 *
 * Every door to a paused project answers PROJECT_PAUSED: its API, MCP,
 * functions and realtime. Its direct Postgres logins connect to the database
 * itself, so a pause, or a deletion (which pauses), stops them as well
 * (lib/projects/paused-logins.ts):
 *
 *   - each login is NOLOGIN with no password, and its open sessions end; its
 *     credential row is kept, marked as stopped by the pause;
 *   - resuming, or restoring the project, brings each marked login back with
 *     its stored password, unless the project is still paused for another
 *     reason; a login that cannot log in for any other reason (a revocation
 *     that stopped part-way, an operator's own hand) carries no mark and is
 *     never brought back, by a resume, a restore or the hourly pass;
 *   - no login is created or re-keyed while paused, and the answer says to
 *     resume first; a rotation while paused leaves the login stopped, and
 *     resuming uses the new password;
 *   - an hourly pass brings every project's logins in line with whether it is
 *     paused, so a hook that failed is repaired; the hooks never throw.
 *
 * Real Postgres and the real definer functions (scripts/setup-direct-access.sql),
 * with logins exercised by logging in as them.
 */

let mockProjectId = ''
jest.mock('@/lib/middleware/projectValidation', () => ({
  withProjectValidation: (_req: any, handler: any) => handler({ projectId: mockProjectId, userId: 'test-user' }),
}))

import '../helpers/real-web-standard'
import { execFileSync } from 'child_process'
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'crypto'
import { Client } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import {
  afterPauseCommitted,
  afterResumeCommitted,
  applyPauseTransition,
  applyResumeTransition,
  withProjectLifecycleLock,
} from '@/lib/projects/pause-lifecycle'
import { requestProjectDeletion, restoreDeletedProject } from '@/lib/projects/deletion'
import {
  directAccessRoleNames,
  getDirectAccessStatus,
  provisionDirectAccess,
  readOnlyLogin,
  revokeDirectAccess,
  rotateDirectAccess,
} from '@/lib/services/direct-access'
import { POST as provisionRoute } from '@/app/api/projects/[id]/database-access/route'

const CONN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || ''
const SYSTEM = { kind: 'system', label: 'paused-logins-spec' } as const
const ORIGINAL_EDITION = process.env.BACKENLY_EDITION

let db: Client
let ownerId = ''
let projectId = ''
let schema = ''
const sessions: Client[] = []

const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows
const canLogIn = async (role: string) => (await q(`SELECT rolcanlogin FROM pg_roles WHERE rolname = $1`, [role]))[0]?.rolcanlogin as boolean | undefined

/** A session that logs in as `role`, as a developer's psql does. */
async function login(role: string, password: string): Promise<Client> {
  const url = new URL(CONN)
  url.username = role
  url.password = password
  const c = new Client({ connectionString: url.toString() })
  c.on('error', () => {})
  await c.connect()
  sessions.push(c)
  return c
}
const loginError = (role: string, password: string) => login(role, password).then(() => 'logged in', (e: Error) => e.message)

/**
 * Whether `password` is the login's password, checked against its stored
 * SCRAM-SHA-256 verifier (RFC 5802, as PostgreSQL stores it), so the answer
 * does not depend on how the cluster's pg_hba authenticates local connections.
 */
async function passwordIs(role: string, password: string): Promise<boolean> {
  const [row] = await q(`SELECT rolpassword FROM pg_authid WHERE rolname = $1`, [role])
  const m = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):/.exec(String(row?.rolpassword ?? ''))
  if (!m) return false
  const salted = pbkdf2Sync(password, Buffer.from(m[2], 'base64'), Number(m[1]), 32, 'sha256')
  const storedKey = createHash('sha256').update(createHmac('sha256', salted).update('Client Key').digest()).digest('base64')
  return storedKey === m[3]
}

/** Open sessions of `role`, waiting up to five seconds for ended ones to go. */
async function sessionsOf(role: string): Promise<number> {
  for (let i = 0; ; i++) {
    const [{ n }] = await q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1`, [role])
    if (n === 0 || i >= 50) return n
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function passwords(): Promise<{ ro: string; rw: string }> {
  const status = await getDirectAccessStatus(projectId)
  const of = (mode: string) => status.credentials.find((c) => c.mode === mode)!.password
  return { ro: of('READ_ONLY'), rw: of('READ_WRITE') }
}

/** A pause as Backenly Cloud's sweep makes one. */
async function pause(id = projectId) {
  const row = await prisma.project.findUniqueOrThrow({ where: { id }, select: { lastActivityAt: true } })
  const result = await withProjectLifecycleLock(id, (tx) =>
    applyPauseTransition(tx, id, { observedLastActivityAt: row.lastActivityAt, reason: 'inactivity' }),
  )
  expect(result.paused).toBe(true)
  await afterPauseCommitted(id, { reason: 'inactivity', actor: SYSTEM, cancelledDeliveries: result.cancelledDeliveries })
}

/** A resume as Cloud's resume route makes one. */
async function resume(id = projectId) {
  const result = await withProjectLifecycleLock(id, (tx) => applyResumeTransition(tx, id))
  expect(result.resumed).toBe(true)
  await afterResumeCommitted(id, SYSTEM)
}

beforeAll(async () => {
  execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-f', 'scripts/setup-direct-access.sql', '-d', CONN], { stdio: 'pipe' })
  db = new Client({ connectionString: CONN })
  await db.connect()
  process.env.BACKENLY_EDITION = 'cloud'
  ownerId = (await prisma.user.create({ data: { email: `paused-logins-${randomBytes(6).toString('hex')}@example.test`, name: 'owner' }, select: { id: true } })).id
  const project = await createProvisionedProject({ name: 'paused-logins', userId: ownerId })
  projectId = project.id
  mockProjectId = projectId
  schema = project.postgresSchema
  await provisionDirectAccess(projectId, 'READ_ONLY')
  await provisionDirectAccess(projectId, 'READ_WRITE')
}, 120_000)

afterEach(async () => {
  for (const c of sessions.splice(0)) await c.end().catch(() => {})
  // Every case starts from a project that is not paused or deleted.
  await prisma.project.update({ where: { id: projectId }, data: { pausedAt: null, pauseReason: null, deletedAt: null, purgeAfter: null } })
})

afterAll(async () => {
  for (const c of sessions) await c.end().catch(() => {})
  if (projectId) {
    await revokeDirectAccess(projectId, 'READ_ONLY').catch(() => {})
    await revokeDirectAccess(projectId, 'READ_WRITE').catch(() => {})
    const own = directAccessRoleNames(projectId).owner
    await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
    await q(`DROP OWNED BY ${own}`).catch(() => {})
    await q(`DROP ROLE IF EXISTS ${own}`).catch(() => {})
    await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  }
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await db.end()
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
}, 120_000)

describe('a pause', () => {
  it('stops the project’s logins: they cannot log in, their open sessions end, and the credentials are kept', async () => {
    const { ro, rw } = directAccessRoleNames(projectId)
    const pw = await passwords()
    const open = await login(ro, pw.ro)
    expect((await open.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }])

    await pause()

    expect(await canLogIn(ro)).toBe(false)
    expect(await canLogIn(rw)).toBe(false)
    expect(await sessionsOf(ro)).toBe(0)
    expect(await passwordIs(ro, pw.ro)).toBe(false)
    expect(await loginError(ro, pw.ro)).not.toBe('logged in')
    expect(await prisma.databaseCredential.count({ where: { projectId } })).toBe(2)
    // Each marked as the pause's, so a resume brings back these two and no other.
    expect(await prisma.databaseCredential.count({ where: { projectId, stoppedForPauseAt: { not: null } } })).toBe(2)
    await resume()
    expect(await prisma.databaseCredential.count({ where: { projectId, stoppedForPauseAt: { not: null } } })).toBe(0)
  }, 60_000)

  it('ends, and resuming brings each login back with the same password', async () => {
    const { ro, rw } = directAccessRoleNames(projectId)
    const pw = await passwords()
    await pause()
    expect(await canLogIn(ro)).toBe(false)

    await resume()

    expect(await canLogIn(ro)).toBe(true)
    expect(await canLogIn(rw)).toBe(true)
    expect(await passwordIs(ro, pw.ro)).toBe(true)
    expect(await passwordIs(rw, pw.rw)).toBe(true)
    expect(await loginError(ro, pw.ro)).toBe('logged in')
    expect(await loginError(rw, pw.rw)).toBe('logged in')
  }, 60_000)

  it('makes and re-keys no login, and says to resume first', async () => {
    const { ro } = directAccessRoleNames(projectId)
    await revokeDirectAccess(projectId, 'READ_WRITE')
    await pause()

    await expect(provisionDirectAccess(projectId, 'READ_WRITE')).rejects.toMatchObject({
      code: 'PROJECT_PAUSED',
      message: "This project is paused, so its Postgres logins don't connect and no new one is made. Resume it first.",
    })
    // Re-keying the read-only login would have given it LOGIN again.
    await expect(provisionDirectAccess(projectId, 'READ_ONLY')).rejects.toMatchObject({ code: 'PROJECT_PAUSED' })
    expect(await canLogIn(ro)).toBe(false)
    const res = await provisionRoute({ json: async () => ({ mode: 'READ_WRITE' }) } as any)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('PROJECT_PAUSED')
    expect(await prisma.databaseCredential.count({ where: { projectId, mode: 'READ_WRITE' } })).toBe(0)

    await resume()
    await provisionDirectAccess(projectId, 'READ_WRITE')
    expect(await canLogIn(directAccessRoleNames(projectId).rw)).toBe(true)
  }, 60_000)

  it('leaves a login stopped through a rotation, and resuming uses the new password', async () => {
    const { ro } = directAccessRoleNames(projectId)
    const before = (await readOnlyLogin(projectId)).password
    await pause()

    const rotated = await rotateDirectAccess(projectId, 'READ_ONLY')
    expect(rotated.password).not.toBe(before)
    expect(await canLogIn(ro)).toBe(false)

    await resume()
    expect(await canLogIn(ro)).toBe(true)
    expect(await passwordIs(ro, rotated.password)).toBe(true)
    expect(await passwordIs(ro, before)).toBe(false)
    expect(await loginError(ro, rotated.password)).toBe('logged in')
  }, 60_000)
})

describe('a deletion', () => {
  it('stops the logins when it is asked for, and restoring the project brings them back', async () => {
    const { ro, rw } = directAccessRoleNames(projectId)
    const pw = await passwords()
    const now = new Date()
    await requestProjectDeletion(projectId, SYSTEM, now)
    expect(await canLogIn(ro)).toBe(false)
    expect(await canLogIn(rw)).toBe(false)

    expect(await restoreDeletedProject(projectId, SYSTEM, now)).toEqual({ restored: true })
    expect(await canLogIn(ro)).toBe(true)
    expect(await passwordIs(rw, pw.rw)).toBe(true)
    expect(await loginError(rw, pw.rw)).toBe('logged in')
  }, 60_000)

  it('keeps them stopped through a restore while the project is still paused for inactivity, until it is resumed', async () => {
    const { ro } = directAccessRoleNames(projectId)
    const now = new Date()
    await pause()
    await requestProjectDeletion(projectId, SYSTEM, now)
    await restoreDeletedProject(projectId, SYSTEM, now)
    expect(await canLogIn(ro)).toBe(false)

    await resume()
    expect(await canLogIn(ro)).toBe(true)
  }, 60_000)
})

describe('the hourly pass and failures', () => {
  it('stops a paused project’s login a failed hook left able to log in, and brings back a resumed one’s', async () => {
    const { reconcileDirectLoginsWithPause } = await import('@/lib/projects/paused-logins')
    const { ro } = directAccessRoleNames(projectId)
    const pw = await passwords()
    await pause()
    // As if stopping it had failed.
    await q(`ALTER ROLE ${ro} LOGIN PASSWORD '${pw.ro}'`)
    expect(await canLogIn(ro)).toBe(true)

    expect((await reconcileDirectLoginsWithPause()).stopped).toBeGreaterThanOrEqual(1)
    expect(await canLogIn(ro)).toBe(false)

    // Resumed with no hook run, as if it had failed.
    await withProjectLifecycleLock(projectId, (tx) => applyResumeTransition(tx, projectId))
    expect((await reconcileDirectLoginsWithPause()).restored).toBeGreaterThanOrEqual(1)
    expect(await canLogIn(ro)).toBe(true)
    expect(await loginError(ro, pw.ro)).toBe('logged in')
  }, 60_000)

  it('never brings back a login stopped for another reason: not on resume, not on restore, not in the hourly pass', async () => {
    const { reconcileDirectLoginsWithPause } = await import('@/lib/projects/paused-logins')
    const { ro, rw } = directAccessRoleNames(projectId)
    const pw = await passwords()
    // As a revocation that stopped part-way leaves it: the login retired, its row kept.
    await q(`SELECT public.backenly_direct_retire_role($1)`, [ro])
    try {
      expect(await canLogIn(ro)).toBe(false)

      await pause()
      expect(await canLogIn(rw)).toBe(false)
      await resume()
      expect(await canLogIn(rw)).toBe(true)
      expect(await canLogIn(ro)).toBe(false)

      const now = new Date()
      await requestProjectDeletion(projectId, SYSTEM, now)
      expect(await restoreDeletedProject(projectId, SYSTEM, now)).toEqual({ restored: true })
      expect(await canLogIn(rw)).toBe(true)
      expect(await canLogIn(ro)).toBe(false)

      await reconcileDirectLoginsWithPause()
      expect(await canLogIn(ro)).toBe(false)
      // An operator's own NOLOGIN, with its password kept, is left as well.
      await q(`ALTER ROLE ${rw} NOLOGIN`)
      await reconcileDirectLoginsWithPause()
      expect(await canLogIn(rw)).toBe(false)
      expect(await prisma.databaseCredential.count({ where: { projectId } })).toBe(2)
    } finally {
      // Back as it was, for the cases after this one.
      await q(`SELECT public.backenly_direct_create_role($1, $2, $3, 'READ_ONLY')`, [ro, pw.ro, schema])
      await q(`ALTER ROLE ${rw} LOGIN`)
    }
  }, 60_000)

  it('never throws out of the hooks: a project whose region this process cannot reach is logged and left', async () => {
    const { restoreDirectLogins, stopDirectLogins } = await import('@/lib/projects/paused-logins')
    const east = await prisma.project.create({ data: { name: 'east', userId: ownerId, region: 'us-east-1' }, select: { id: true } })
    await prisma.databaseCredential.create({
      data: { projectId: east.id, mode: 'READ_ONLY', roleName: directAccessRoleNames(east.id).ro, passwordCipher: 'x', passwordIv: 'x', passwordTag: 'x' },
    })
    const said = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(stopDirectLogins(east.id, 'paused')).resolves.toEqual([])
      await expect(restoreDirectLogins(east.id, 'resumed')).resolves.toEqual([])
      expect(said.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/logins not stopped \(paused\): RegionNotConfiguredError; the hourly pass tries again/)
    } finally {
      said.mockRestore()
      await prisma.databaseCredential.deleteMany({ where: { projectId: east.id } })
      await prisma.project.delete({ where: { id: east.id } })
    }
  })
})
