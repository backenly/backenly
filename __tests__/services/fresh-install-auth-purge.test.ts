/**
 * A FRESH INSTALL MUST NOT FILL ITS LOG WITH ERRORS ABOUT A NON-EVENT
 * ==================================================================
 * `purgeSyntheticAuthArtifacts` runs from the autonomy verifiers on the
 * scheduler. It deletes test rows from the end-user auth tables — `users`,
 * `_email_verifications`, `_magic_links`, `_password_resets` — none of which
 * exist until a project actually enables end-user auth.
 *
 * It already carried a pre-check against `information_schema.tables`, added
 * after exactly this noise was reported once before. The pre-check had a hole:
 *
 *     if (existing.size > 0 && !existing.has(table)) return
 *
 * An empty set was treated as "introspection failed, try anyway". But an empty
 * set is also what a BRAND NEW workspace returns, because it has no tables yet.
 * So on the one deployment where the guard mattered most it was skipped, every
 * DELETE was attempted, and the operator's first look at their own install was
 * a wall of `relation ... does not exist`.
 *
 * The distinction is between "the lookup answered nothing" and "the lookup did
 * not answer". This asserts the first case behaves, against a real empty
 * schema — which is the only place the bug lived.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { spawnSync } from 'child_process'
import { resolve } from 'path'
import { prisma } from '@/lib/db/prisma'
import { purgeSyntheticAuthArtifacts } from '@/lib/services/end-user-auth-table'

let userId: string
let emptyProjectId: string
let populatedProjectId: string
let emptySchema: string
let populatedSchema: string

const raw = (sql: string) => prisma.$executeRawUnsafe(sql)

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `freshpurge-${Date.now()}@example.test`, password: 'x', name: 'fresh purge' },
  })
  userId = user.id

  // The fresh-install shape: a workspace schema that exists and is EMPTY.
  const empty = await prisma.project.create({ data: { name: 'purge-empty', userId } })
  emptyProjectId = empty.id
  emptySchema = `workspace_${emptyProjectId}`
  await raw(`CREATE SCHEMA "${emptySchema}"`)

  // A project that has enabled auth, so the positive case is exercised too.
  const populated = await prisma.project.create({ data: { name: 'purge-populated', userId } })
  populatedProjectId = populated.id
  populatedSchema = `workspace_${populatedProjectId}`
  await raw(`CREATE SCHEMA "${populatedSchema}"`)
  await raw(`CREATE TABLE "${populatedSchema}"."users" (
    id serial primary key, email text NOT NULL, created_at timestamptz DEFAULT now()
  )`)
  await raw(`INSERT INTO "${populatedSchema}"."users"(email) VALUES ('real@example.test')`)
}, 120_000)

afterAll(async () => {
  await raw(`DROP SCHEMA IF EXISTS "${emptySchema}" CASCADE`).catch(() => {})
  await raw(`DROP SCHEMA IF EXISTS "${populatedSchema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: [emptyProjectId, populatedProjectId] } } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
}, 60_000)

/**
 * Run the purge in a SUBPROCESS and capture everything it printed.
 *
 * An in-process capture was tried first: it replaced `process.stderr.write` and
 * `console.error`, and it saw nothing — the suite passed identically against
 * the buggy code, which made it worthless. Prisma's logger does not
 * necessarily reach either of those hooks under jest.
 *
 * So the output is captured where it actually appears: the child's own stderr.
 * That is also the form an operator sees, which is the thing being asserted.
 */
function purgeInSubprocess(projectId: string): string {
  const url = process.env.TEST_DATABASE_URL!
  const runner = resolve(__dirname, '../../scripts/probe-purge-output.ts')
  const r = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', runner, projectId],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url, NODE_ENV: 'test' },
    },
  )
  return `${r.stdout ?? ''}${r.stderr ?? ''}`
}

describe('a freshly installed workspace with no tables', () => {
  test('purging synthetic auth artifacts logs no missing-relation error', async () => {
    const output = purgeInSubprocess(emptyProjectId)

    // The exact text an operator saw, for each of the four tables.
    for (const table of ['users', '_email_verifications', '_magic_links', '_password_resets']) {
      expect(output).not.toContain(`"${emptySchema}"."${table}" does not exist`)
    }
    expect(output).not.toMatch(/relation .* does not exist/i)
    expect(output).not.toContain('prisma:error')
  }, 60_000)

  test('it returns cleanly rather than throwing', async () => {
    // Silence must not have been bought by swallowing a failure upstream.
    await expect(purgeSyntheticAuthArtifacts(emptyProjectId)).resolves.toBeDefined()
  }, 60_000)

  test('the schema really is empty, so the case above is the fresh-install one', async () => {
    // Guards the guard: if the schema had tables, the pre-check would have
    // taken a different branch and this suite would prove nothing.
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM information_schema.tables WHERE table_schema = $1`,
      emptySchema,
    )
    expect(Number(rows[0].n)).toBe(0)
  })
})

describe('a workspace that has enabled auth', () => {
  test('still purges, so the fix did not simply disable the sweep', async () => {
    // The positive half. Skipping every table would also produce a silent log,
    // and would be a much worse bug than the noise it replaced.
    // A `.internal` domain is what SYNTHETIC_USER_SQL matches. A first draft
    // used a `__http_bv_` prefix, which is the TARGETED-mode spelling and not
    // what a sweep looks for - the fixture was wrong, not the sweep.
    await raw(
      `INSERT INTO "${populatedSchema}"."users"(email) VALUES ('probe@verifier.internal')`
    )

    const before = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM "${populatedSchema}"."users"`
    )
    expect(Number(before[0].n)).toBe(2)

    await purgeSyntheticAuthArtifacts(populatedProjectId)

    const after = await prisma.$queryRawUnsafe<Array<{ email: string }>>(
      `SELECT email FROM "${populatedSchema}"."users" ORDER BY email`
    )
    // The synthetic row is gone; the real one is untouched.
    expect(after.map(r => r.email)).toEqual(['real@example.test'])
  }, 60_000)
})
