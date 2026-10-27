/**
 * A project whose agent turned auth on before anyone signed up.
 *
 * Reproduced on a composed Cloud stack from a customer's report, in this order:
 *   1. `auth { action: "enable" }` succeeded, but only the first sign-up
 *      created the end-user `users` table;
 *   2. the agent's first migration, `CREATE TABLE profiles (user_id uuid
 *      REFERENCES users(id))`, failed with 42P01 directly and again when a
 *      person approved the branch merge that replays it;
 *   3. within a minute the loop filed "users table missing" (critical), then
 *      marked it "Backenly fixed" in the same pass that verified the table was
 *      missing, and asked for "Approve & fix" on RLS for a users table that did
 *      not exist, which failed with a 500;
 *   4. once someone signed up, the deploy gate failed the project's auth check
 *      (a flag nothing that enables auth sets) while Autonomy said all clear.
 *
 * Real PostgreSQL throughout: the executor, the migration dispatch, the
 * observer and the readiness gate, as the product runs them.
 */
import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { applyMigrationToMain } from '@/lib/mcp/apply-migration'
import { executeAction } from '@/lib/ai/minimal-executor'
import { runObserverForProject } from '@/lib/services/workspace-observer'
import { scoreReadiness } from '@/lib/deployment/readiness-scorer'

const saved = {
  ENGINE_MODE: process.env.ENGINE_MODE,
  BACKENLY_EDITION: process.env.BACKENLY_EDITION,
  ENABLE_VERIFICATION_EXECUTION: process.env.ENABLE_VERIFICATION_EXECUTION,
  ENABLE_SAFE_VERIFICATION_MODE: process.env.ENABLE_SAFE_VERIFICATION_MODE,
  CONTRACT_PROBE_ORIGIN: process.env.CONTRACT_PROBE_ORIGIN,
}

let ownerId: string
const projects: Array<{ id: string; schema: string }> = []

async function project(name: string): Promise<{ id: string; schema: string }> {
  const p = await createProvisionedProject({ name, userId: ownerId })
  await prisma.project.update({ where: { id: p.id }, data: { protectedProduction: false } })
  const made = { id: p.id, schema: p.postgresSchema }
  projects.push(made)
  return made
}

async function tables(schema: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = ${schema} ORDER BY 1`
  return rows.map((r) => r.table_name)
}

/** Auth on as an older project has it: the graph says so, and nobody signed up. */
async function authOnWithoutUsersTable(projectId: string): Promise<void> {
  const { activeGraphId } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { activeGraphId: true } })
  const graph = await prisma.backendGraph.findUniqueOrThrow({ where: { id: activeGraphId! } })
  await prisma.backendGraph.update({
    where: { id: graph.id },
    data: { graphData: { ...(graph.graphData as object), auth: { providers: { email: { enabled: true } } } } },
  })
}

beforeAll(async () => {
  process.env.ENGINE_MODE = 'runtime'
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENABLE_VERIFICATION_EXECUTION = 'true'
  process.env.ENABLE_SAFE_VERIFICATION_MODE = 'true'
  // Nothing listens here, so no contract probe can file anything of its own.
  process.env.CONTRACT_PROBE_ORIGIN = 'http://127.0.0.1:9'
  ownerId = (await prisma.user.create({
    data: { email: `auth-first-${crypto.randomUUID()}@example.test`, password: 'test-only-hash', name: 'auth first' },
  })).id
}, 120_000)

afterAll(async () => {
  for (const p of projects) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${p.schema}" CASCADE`).catch(() => {})
    await prisma.healthFinding.deleteMany({ where: { projectId: p.id } }).catch(() => {})
  }
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}, 120_000)

describe('enabling auth', () => {
  it('creates the users table with its own-rows policy, as a change on the history', async () => {
    const p = await project('auth-enable')
    const result = await executeAction({ action: 'ENABLE_AUTH', params: {} } as any, p.id)
    expect(result.success).toBe(true)

    expect(await tables(p.schema)).toContain('users')
    const policy = await prisma.permissionPolicy.findFirst({ where: { projectId: p.id, tableName: 'users' } })
    expect(policy).not.toBeNull()
    const change = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM backend_changes WHERE "projectId" = ${p.id}`
    expect(Number(change[0].n)).toBeGreaterThan(0)
  }, 120_000)

  // Older projects still hold a plaintext signing secret, which sign-in accepts.
  // Enabling auth must leave it alone: decrypting it as the canonical format
  // fails, and that failure used to be one refactor away from failing auth itself.
  it('keeps a legacy plaintext secret as it is', async () => {
    const p = await project('auth-enable-legacy-secret')
    const legacy = crypto.randomBytes(32).toString('hex')
    await prisma.project.update({ where: { id: p.id }, data: { jwtSecret: legacy } })

    const result = await executeAction({ action: 'ENABLE_AUTH', params: {} } as any, p.id)
    expect(result.success).toBe(true)

    const row = await prisma.project.findUnique({ where: { id: p.id }, select: { jwtSecret: true } })
    expect(row?.jwtSecret).toBe(legacy)
    expect(await tables(p.schema)).toContain('users')
  }, 120_000)
})

describe('a key into users on a project nobody has signed up to', () => {
  it('is created, with the users table it needs', async () => {
    const p = await project('users-reference')
    const result = await applyMigrationToMain(
      p.id,
      ownerId,
      'CREATE TABLE profiles (user_id uuid NOT NULL REFERENCES users(id), display_name text)',
      { workspaceSchema: p.schema, agentSurface: true },
    )
    expect(result).toMatchObject({ ok: true })
    expect(await tables(p.schema)).toEqual(expect.arrayContaining(['profiles', 'users']))

    const fk = await prisma.$queryRaw<Array<{ ref: string }>>`
      SELECT ccu.table_name AS ref
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
       WHERE tc.table_schema = ${p.schema} AND tc.table_name = 'profiles' AND tc.constraint_type = 'FOREIGN KEY'`
    expect(fk.map((r) => r.ref)).toEqual(['users'])
  }, 120_000)

  it('never creates anything for a key into another table', async () => {
    const p = await project('other-reference')
    expect((await applyMigrationToMain(p.id, ownerId, 'CREATE TABLE teams (name text)', {
      workspaceSchema: p.schema, agentSurface: true,
    })).ok).toBe(true)
    expect((await applyMigrationToMain(p.id, ownerId, 'CREATE TABLE members (team_id uuid REFERENCES teams(id))', {
      workspaceSchema: p.schema, agentSurface: true,
    })).ok).toBe(true)
    expect(await tables(p.schema)).not.toContain('users')
  }, 120_000)
})

describe('the loop on a project with auth on and no users table yet', () => {
  it('files no missing table, no broken auth workflow and no failed verification', async () => {
    const p = await project('auth-on-quiet')
    // Something built, so the project is watched.
    expect((await applyMigrationToMain(p.id, ownerId, 'CREATE TABLE notes (body text)', {
      workspaceSchema: p.schema, agentSurface: true,
    })).ok).toBe(true)
    await authOnWithoutUsersTable(p.id)
    expect(await tables(p.schema)).not.toContain('users')

    await runObserverForProject(p.id)

    const rows = await prisma.healthFinding.findMany({ where: { projectId: p.id }, select: { type: true, status: true } })
    expect(rows.filter((f) => ['auth_users_table_missing', 'workflow_broken', 'verification_failed'].includes(f.type))).toEqual([])
  }, 180_000)

  it('still reports a users table that existed and is gone', async () => {
    const p = await project('auth-table-dropped')
    await executeAction({ action: 'ENABLE_AUTH', params: {} } as any, p.id)
    await prisma.$executeRawUnsafe(`DROP TABLE "${p.schema}"."users" CASCADE`)

    await runObserverForProject(p.id)

    const missing = await prisma.healthFinding.findMany({
      where: { projectId: p.id, type: 'auth_users_table_missing', status: { in: ['open', 'pending_approval'] } },
    })
    expect(missing).toHaveLength(1)
  }, 180_000)
})

describe('what clears without Backenly is withdrawn, claim by claim', () => {
  it('closes a finding only by the check of its own claim, and never as a fix', async () => {
    const p = await project('reaper')
    await executeAction({ action: 'ENABLE_AUTH', params: {} } as any, p.id)
    // Protected by its creation: RLS with an owner policy.
    expect((await applyMigrationToMain(p.id, ownerId, 'CREATE TABLE todos (user_id uuid REFERENCES users(id), title text)', {
      workspaceSchema: p.schema, agentSurface: true,
    })).ok).toBe(true)
    // Unprotected, and with no user_id column, so the narrow RLS scenario passes.
    await prisma.$executeRawUnsafe(`CREATE TABLE "${p.schema}"."ledger" (id uuid PRIMARY KEY, author_id uuid, amount int)`)

    const stale = await prisma.healthFinding.create({
      data: { projectId: p.id, type: 'auth_users_table_missing', severity: 'critical', status: 'open', details: { reason: 'stale' } },
    })
    const protectedRls = await prisma.healthFinding.create({
      data: { projectId: p.id, type: 'missing_rls', severity: 'warning', status: 'open', details: { tableName: 'todos' } },
    })
    const unprotectedRls = await prisma.healthFinding.create({
      data: { projectId: p.id, type: 'missing_rls', severity: 'warning', status: 'pending_approval', details: { tableName: 'ledger' } },
    })

    await runObserverForProject(p.id)

    const after = async (id: string) => prisma.healthFinding.findUnique({ where: { id } })
    for (const id of [stale.id, protectedRls.id]) {
      const row = await after(id)
      expect(row).toMatchObject({ status: 'dismissed', autoFixed: false })
      expect((row!.details as Record<string, unknown>).withdrawnBy).toBe('verification_reaper')
    }
    // The table nothing protects keeps its finding, whatever passed.
    expect((await after(unprotectedRls.id))?.status).toBe('pending_approval')
  }, 180_000)
})

describe('the deploy gate reads auth as every other surface does', () => {
  it('passes with auth on, before and after the users table exists, and never asks for a flag', async () => {
    const p = await project('readiness-auth')
    await authOnWithoutUsersTable(p.id)

    const before = await scoreReadiness(p.id)
    expect(before.checks.find((c) => c.id === 'end_user_auth_table')).toMatchObject({ status: 'pass' })

    await executeAction({ action: 'ENABLE_AUTH', params: {} } as any, p.id)
    const after = await scoreReadiness(p.id)
    expect(after.checks.find((c) => c.id === 'end_user_auth_table')).toMatchObject({ status: 'pass' })
    expect(after.blockers.map((b) => b.id)).not.toContain('end_user_auth_table')

    const row = await prisma.project.findUnique({ where: { id: p.id }, select: { authManifest: true } })
    expect(row?.authManifest ?? null).toBeNull()
  }, 180_000)
})
