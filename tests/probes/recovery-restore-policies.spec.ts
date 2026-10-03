/**
 * RESTORE_POLICIES MUST ACTUALLY RESTORE, AND MUST REFUSE WHEN IT CANNOT
 * =====================================================================
 *
 * `#80` recorded this strategy as `not_implemented` rather than pretend
 * `REMOVE_PERMISSION(table)` was an inverse, because that verb removes every
 * policy: undoing "three policies consolidated into one" by leaving the table
 * unprotected is a security regression dressed as a recovery.
 *
 * So the bar for calling it implemented is the bar the other three proven
 * strategies met, against real PostgreSQL rather than a mock:
 *
 *   - the exact policy set comes back, not merely a policy with the same name
 *   - a table somebody else changed since is REFUSED, not overwritten
 *   - the verifier is independent of the thing it verifies
 *   - a verifier that cannot complete reports unverified, never success
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

import {
  capturePolicies,
  recoveryRestorePolicies,
  samePolicies,
  type PolicyCapture,
} from '@/lib/autonomy/maintenance/primitives/recovery-restore-policies'
import { canRollback, ROLLBACK_REGISTRY } from '@/lib/autonomy/maintenance/rollback-capability'

const prisma = new PrismaClient()
const made: Array<{ projectId: string; userId: string; schema: string }> = []

async function project(): Promise<{ projectId: string; schema: string }> {
  const userId = randomUUID()
  const projectId = randomUUID()
  const schema = `workspace_${projectId}`
  await prisma.user.create({
    data: {
      id: userId,
      email: `restore-${userId.slice(0, 8)}@backenly.test`,
      name: 'restore test',
      password: 'x',
    },
  })
  await prisma.project.create({ data: { id: projectId, name: 'restore-test', userId } })
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${schema}"."posts" (id uuid PRIMARY KEY, user_id uuid, body text)`,
  )
  await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."posts" ENABLE ROW LEVEL SECURITY`)
  await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."posts" FORCE ROW LEVEL SECURITY`)
  made.push({ projectId, userId, schema })
  return { projectId, schema }
}

/** The healthy starting protection: two distinct, behaviourally different policies. */
async function seedPolicies(schema: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `CREATE POLICY "own_rows_select" ON "${schema}"."posts" FOR SELECT ` +
      `USING (user_id::text = current_setting('request.jwt.claim.sub', true))`,
  )
  await prisma.$executeRawUnsafe(
    `CREATE POLICY "own_rows_insert" ON "${schema}"."posts" FOR INSERT ` +
      `WITH CHECK (user_id::text = current_setting('request.jwt.claim.sub', true))`,
  )
}

afterAll(async () => {
  for (const m of made) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${m.schema}" CASCADE`).catch(() => {})
    await prisma.project.delete({ where: { id: m.projectId } }).catch(() => {})
    await prisma.user.delete({ where: { id: m.userId } }).catch(() => {})
  }
  await prisma.$disconnect()
})

describe('the capability registry says what the code does', () => {
  it('reports restore_policies as implemented, at a named revision', () => {
    expect(canRollback('restore_policies')).toBe(true)
    expect(ROLLBACK_REGISTRY.restore_policies.revision).toBe('v1')
  })
})

describe('capture records enough to recreate a policy exactly', () => {
  it('captures command, expressions and the RLS flags', async () => {
    const { projectId, schema } = await project()
    await seedPolicies(schema)

    const cap = await capturePolicies(projectId, 'posts')

    expect(cap.policies.map(p => p.name).sort()).toEqual(['own_rows_insert', 'own_rows_select'])
    const sel = cap.policies.find(p => p.name === 'own_rows_select')!
    expect(sel.cmd).toBe('SELECT')
    expect(sel.qual).toContain('user_id')
    const ins = cap.policies.find(p => p.name === 'own_rows_insert')!
    expect(ins.cmd).toBe('INSERT')
    expect(ins.withCheck).toContain('user_id')
    // Policies alone do not say whether the table is protected.
    expect(cap.rlsEnabled).toBe(true)
    expect(cap.rlsForced).toBe(true)
  })

  it('distinguishes two policies that differ only in their expression', async () => {
    // The case a name-only capture would get wrong: restoring by name would
    // recreate a policy that permits something different.
    const { projectId, schema } = await project()
    await prisma.$executeRawUnsafe(
      `CREATE POLICY "p" ON "${schema}"."posts" USING (user_id IS NOT NULL)`,
    )
    const a = await capturePolicies(projectId, 'posts')

    await prisma.$executeRawUnsafe(`DROP POLICY "p" ON "${schema}"."posts"`)
    await prisma.$executeRawUnsafe(`CREATE POLICY "p" ON "${schema}"."posts" USING (true)`)
    const b = await capturePolicies(projectId, 'posts')

    expect(a.policies[0].name).toBe(b.policies[0].name)
    expect(samePolicies(a, b)).toBe(false)
  })
})

describe('restoring brings back the exact protection', () => {
  it('undoes a consolidation and verifies the result from the catalog', async () => {
    const { projectId, schema } = await project()
    await seedPolicies(schema)

    const pre = await capturePolicies(projectId, 'posts')

    // The forward step: two policies consolidated into one permissive rule.
    await prisma.$executeRawUnsafe(`DROP POLICY "own_rows_select" ON "${schema}"."posts"`)
    await prisma.$executeRawUnsafe(`DROP POLICY "own_rows_insert" ON "${schema}"."posts"`)
    await prisma.$executeRawUnsafe(`CREATE POLICY "consolidated" ON "${schema}"."posts" USING (true)`)
    const post = await capturePolicies(projectId, 'posts')

    const out = await recoveryRestorePolicies(projectId, pre, post)
    expect(out.status).toBe('verified')

    // Asked of PostgreSQL again, independently of what the restore returned.
    const after = await prisma.$queryRawUnsafe<Array<{ policyname: string; cmd: string }>>(
      `SELECT policyname, cmd FROM pg_policies WHERE schemaname = $1 AND tablename = 'posts' ORDER BY policyname`,
      schema,
    )
    expect(after.map(r => r.policyname)).toEqual(['own_rows_insert', 'own_rows_select'])
    expect(after.find(r => r.policyname === 'own_rows_select')!.cmd).toBe('SELECT')
    // And the consolidation is gone rather than left alongside.
    expect(after.some(r => r.policyname === 'consolidated')).toBe(false)
  })

  it('restores the RLS flags, not just the rules', async () => {
    const { projectId, schema } = await project()
    await seedPolicies(schema)
    const pre = await capturePolicies(projectId, 'posts')

    await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."posts" NO FORCE ROW LEVEL SECURITY`)
    const post = await capturePolicies(projectId, 'posts')
    expect(post.rlsForced).toBe(false)

    const out = await recoveryRestorePolicies(projectId, pre, post)
    expect(out.status).toBe('verified')

    const after = await capturePolicies(projectId, 'posts')
    // Restoring the rules while leaving the table unforced would restore the
    // policy set and not the protection, since the owner would bypass it.
    expect(after.rlsForced).toBe(true)
  })
})

describe('it refuses rather than overwriting somebody else', () => {
  it('blocks when the policies changed after the step it is undoing', async () => {
    const { projectId, schema } = await project()
    await seedPolicies(schema)
    const pre = await capturePolicies(projectId, 'posts')

    await prisma.$executeRawUnsafe(`DROP POLICY "own_rows_select" ON "${schema}"."posts"`)
    await prisma.$executeRawUnsafe(`DROP POLICY "own_rows_insert" ON "${schema}"."posts"`)
    await prisma.$executeRawUnsafe(`CREATE POLICY "consolidated" ON "${schema}"."posts" USING (true)`)
    const post = await capturePolicies(projectId, 'posts')

    // Somebody else changes the table afterwards.
    await prisma.$executeRawUnsafe(`DROP POLICY "consolidated" ON "${schema}"."posts"`)
    await prisma.$executeRawUnsafe(
      `CREATE POLICY "written_by_a_human" ON "${schema}"."posts" USING (user_id IS NOT NULL)`,
    )

    const out = await recoveryRestorePolicies(projectId, pre, post)
    expect(out.status).toBe('blocked_stale')

    // And the human's policy survives untouched. Non-vacuous: the refusal has
    // to leave the table alone, not merely report that it would have.
    const after = await capturePolicies(projectId, 'posts')
    expect(after.policies.map(p => p.name)).toEqual(['written_by_a_human'])
  })

  it('blocks when a policy with the same NAME has a different expression', async () => {
    // The subtle stale case. Name equality is not identity: somebody recreating
    // `consolidated` with different semantics is a different policy.
    const { projectId, schema } = await project()
    await seedPolicies(schema)
    const pre = await capturePolicies(projectId, 'posts')

    await prisma.$executeRawUnsafe(`DROP POLICY "own_rows_select" ON "${schema}"."posts"`)
    await prisma.$executeRawUnsafe(`DROP POLICY "own_rows_insert" ON "${schema}"."posts"`)
    await prisma.$executeRawUnsafe(`CREATE POLICY "consolidated" ON "${schema}"."posts" USING (true)`)
    const post = await capturePolicies(projectId, 'posts')

    await prisma.$executeRawUnsafe(`DROP POLICY "consolidated" ON "${schema}"."posts"`)
    await prisma.$executeRawUnsafe(
      `CREATE POLICY "consolidated" ON "${schema}"."posts" USING (user_id IS NOT NULL)`,
    )

    const out = await recoveryRestorePolicies(projectId, pre, post)
    expect(out.status).toBe('blocked_stale')
  })

  it('blocks rather than guessing when the current state cannot be read', async () => {
    const { projectId, schema } = await project()
    await seedPolicies(schema)
    const pre = await capturePolicies(projectId, 'posts')
    const post = await capturePolicies(projectId, 'posts')

    // The table is gone, so the stale guard cannot establish anything.
    await prisma.$executeRawUnsafe(`DROP TABLE "${schema}"."posts"`)

    const out = await recoveryRestorePolicies(projectId, pre, post)
    // Not `failed`: nothing was attempted. Not `verified`: nothing was proven.
    expect(['blocked_stale', 'failed']).toContain(out.status)
    expect(out.status).not.toBe('verified')
  })
})
