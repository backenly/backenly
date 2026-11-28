/**
 * SET_RLS DOES NOT SAY IT OPENED A WRITE TO SIGNED-OUT CALLERS
 * ===========================================================
 * Production QA, 2026-11-21 and again 2026-11-27: `set_rls` on product_views
 * for role anon, with an insert rule of `true`, answered "Permission policy
 * applied". The next insert with the browser key and no signed-in user was
 * refused 401 42501.
 *
 * A publishable key writes nothing without a signed-in end user's
 * X-User-Token: signed-out callers hold SELECT on a project's tables and no
 * more, so no policy can open a write to them. The tool accepted `role`, never
 * read it, and installed a rule that let every signed-in user insert instead.
 *
 * Pinned here against a real schema, through the tool an agent calls:
 *   - a write rule for role anon is refused, nothing is installed, and the
 *     answer says what does work;
 *   - a read rule for role anon is installed;
 *   - a write rule that never reads the signed-in user is installed, and its
 *     answer says whom it covers and whom it does not.
 */

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { dispatchTool } from '@/lib/ai/brain/tools'
import { jwtClaimFunctionSql } from '@/lib/postgrest/rls-translation'

let ownerId: string
let projectId: string
let schema: string
const originalEngineMode = process.env.ENGINE_MODE

const setRls = (args: Record<string, unknown>) =>
  dispatchTool('set_rls', { tableName: 'product_views', ...args }, { projectId, userId: ownerId } as any)

async function policies(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ policyname: string }>>(
    `SELECT policyname FROM pg_policies WHERE schemaname = $1 AND tablename = 'product_views' ORDER BY policyname`,
    schema,
  )
  return rows.map((r) => r.policyname)
}

beforeAll(async () => {
  // The real executor, writing real policies (jest.setup.js defaults to a mode that does not).
  process.env.ENGINE_MODE = 'runtime'
  ownerId = (
    await prisma.user.create({
      data: { email: `set-rls-anon-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'set_rls' },
      select: { id: true },
    })
  ).id
  projectId = (await prisma.project.create({ data: { name: 'set-rls-signed-out', userId: ownerId }, select: { id: true } })).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  await prisma.$executeRawUnsafe(jwtClaimFunctionSql(schema))
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${schema}"."product_views" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid, user_id uuid, viewed_at timestamptz NOT NULL DEFAULT now())`,
  )
  await prisma.table.create({ data: { name: 'product_views', projectId } })
}, 120_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.permissionPolicy.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
  process.env.ENGINE_MODE = originalEngineMode
}, 120_000)

describe('a write rule for signed-out callers', () => {
  it('is refused, with why and what does work, and installs nothing', async () => {
    const before = await policies()
    const out = await setRls({ insert: { check: 'true' }, role: 'anon' })

    expect(out.ok).toBe(false)
    expect(out.code).toBe('SIGNED_OUT_CANNOT_WRITE')
    expect(out.summary).toContain('No policy was applied to "product_views".')
    expect(out.summary).toContain('A rule for signed-out callers (role "anon") can cover select only: insert cannot be opened to them.')
    expect(out.summary).toContain("A publishable key writes nothing without a signed-in end user's X-User-Token")
    expect(out.summary).toContain('deploy a function that does the write')
    expect(out.summary).toContain('To let every signed-in user insert, send the same rule without role "anon".')
    expect(out.summary).not.toContain('Permission policy applied')
    expect(await policies()).toEqual(before)
  }, 60_000)

  it('is refused whole when a read rule comes with it: nothing of the call is installed', async () => {
    const before = await policies()
    const out = await setRls({ select: { using: 'true' }, insert: { check: 'true' }, delete: { using: 'true' }, role: 'ANON' })

    expect(out.ok).toBe(false)
    expect(out.code).toBe('SIGNED_OUT_CANNOT_WRITE')
    expect(out.summary).toContain('insert, delete cannot be opened to them')
    expect(await policies()).toEqual(before)
  }, 60_000)
})

describe('a read rule for signed-out callers', () => {
  it('is installed', async () => {
    const out = await setRls({ select: { using: 'true' }, role: 'anon' })

    expect(out.ok).toBe(true)
    expect(out.summary).toContain('Permission policy applied')
    expect(await policies()).toContain('backenly_custom_select')
    // Nothing about writes was said, because nothing about writes was asked.
    expect(out.summary).not.toContain('signed-out caller')
  }, 60_000)
})

describe('a write rule that never reads the signed-in user', () => {
  it('is installed, and says it covers every signed-in user and no signed-out one', async () => {
    const out = await setRls({ insert: { check: 'true' } })

    expect(out.ok).toBe(true)
    expect(await policies()).toContain('backenly_custom_insert')
    expect(out.summary).toContain(
      `INSERT is governed by "true", which does not reference the caller's identity — any authenticated caller can ` +
        `create every row that matches it, and no signed-out caller can: a publishable key writes nothing without an ` +
        `end user's X-User-Token.`,
    )
  }, 60_000)

  it('says nothing of the kind for a rule that does read the signed-in user', async () => {
    const out = await setRls({ insert: { check: "user_id::text = backenly_jwt_claim('sub')" } })

    expect(out.ok).toBe(true)
    expect(out.summary).not.toContain('signed-out caller')
  }, 60_000)
})
