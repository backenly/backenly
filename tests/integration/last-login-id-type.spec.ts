/**
 * Sign-in stamps last_login whatever type the workspace gave users.id.
 *
 * stampLastLogin bound the id as text, and `uuid = text` has no operator, so on
 * every workspace whose users.id is uuid the stamp failed. Its callers catch the
 * error by design (a stamp must never break sign-in), so nothing failed visibly:
 * the Auth dashboard's "active · 30d" simply never counted anyone, and the only
 * trace was a prisma:error line per sign-in. The contract probe made it one per
 * minute per project once its signup stopped failing first (#172).
 *
 * Real Postgres: the property is which comparisons the server accepts, which
 * only the server can say. One project per id type, each with its own workspace
 * users table, and the id passed exactly as sign-in passes it (the row's value).
 */
import { PrismaClient } from '@prisma/client'
import crypto from 'crypto'

import { stampLastLogin } from '@/lib/services/end-user-auth-table'

const prisma = new PrismaClient()

let ownerId: string
const projects: Record<string, string> = {}

const CASES = {
  uuid: 'id uuid PRIMARY KEY DEFAULT gen_random_uuid()',
  text: 'id text PRIMARY KEY',
  bigint: 'id bigserial PRIMARY KEY',
} as const

async function workspaceWith(kind: keyof typeof CASES): Promise<string> {
  const project = await prisma.project.create({
    data: {
      name: `last-login-${kind}`,
      userId: ownerId,
      description: 'last_login id type suite',
      jwtSecret: crypto.randomBytes(32).toString('hex'),
    },
    select: { id: true },
  })
  const schema = `workspace_${project.id}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${schema}"."users" (${CASES[kind]}, email text UNIQUE NOT NULL, password text NOT NULL)`,
  )
  return project.id
}

async function lastLogin(projectId: string, email: string): Promise<Date | null> {
  const rows = await prisma.$queryRawUnsafe<{ last_login: Date | null }[]>(
    `SELECT last_login FROM "workspace_${projectId}"."users" WHERE email = $1`,
    email,
  )
  return rows[0]?.last_login ?? null
}

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: {
      email: `last-login-${crypto.randomBytes(6).toString('hex')}@example.test`,
      password: 'not-a-real-hash',
      name: 'Last Login Suite',
    },
    select: { id: true },
  })
  ownerId = owner.id
  for (const kind of Object.keys(CASES) as (keyof typeof CASES)[]) {
    projects[kind] = await workspaceWith(kind)
  }
}, 180_000)

afterAll(async () => {
  for (const projectId of Object.values(projects)) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
  }
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await prisma.$disconnect()
}, 120_000)

describe('stampLastLogin binds the id as the column type', () => {
  it('stamps a uuid-keyed user (the case that failed with uuid = text)', async () => {
    const p = projects.uuid
    const [{ id }] = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "workspace_${p}"."users" (email, password) VALUES ('u@example.test', 'x') RETURNING id`,
    )
    expect(await lastLogin(p, 'u@example.test')).toBeNull()
    await stampLastLogin(p, id)
    expect(await lastLogin(p, 'u@example.test')).toBeInstanceOf(Date)
  }, 60_000)

  it('stamps a text-keyed user, including one whose text id looks like a uuid', async () => {
    const p = projects.text
    const uuidShaped = crypto.randomUUID()
    await prisma.$executeRawUnsafe(
      `INSERT INTO "workspace_${p}"."users" (id, email, password) VALUES ('usr_1', 't1@example.test', 'x'), ($1, 't2@example.test', 'x')`,
      uuidShaped,
    )
    await stampLastLogin(p, 'usr_1')
    await stampLastLogin(p, uuidShaped)
    expect(await lastLogin(p, 't1@example.test')).toBeInstanceOf(Date)
    expect(await lastLogin(p, 't2@example.test')).toBeInstanceOf(Date)
  }, 60_000)

  it('stamps a bigint-keyed user, given the id as a number or as a string', async () => {
    const p = projects.bigint
    const rows = await prisma.$queryRawUnsafe<{ id: bigint }[]>(
      `INSERT INTO "workspace_${p}"."users" (email, password) VALUES ('n1@example.test', 'x'), ('n2@example.test', 'x') RETURNING id`,
    )
    await stampLastLogin(p, Number(rows[0].id))
    await stampLastLogin(p, String(rows[1].id))
    expect(await lastLogin(p, 'n1@example.test')).toBeInstanceOf(Date)
    expect(await lastLogin(p, 'n2@example.test')).toBeInstanceOf(Date)
  }, 60_000)

  it('stamps only the signed-in user', async () => {
    const p = projects.uuid
    await prisma.$executeRawUnsafe(`INSERT INTO "workspace_${p}"."users" (email, password) VALUES ('other@example.test', 'x')`)
    expect(await lastLogin(p, 'other@example.test')).toBeNull()
  }, 60_000)
})
