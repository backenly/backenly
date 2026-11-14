/**
 * THE TEAMS TABLES: MEMBERSHIP DECIDES WHO READS AND CHANGES THEM
 * ==============================================================
 * enable_teams creates organizations, organization_members and
 * organization_invitations. Their row-level security was left to the
 * ownership inference, which cannot say that membership decides access, and
 * every workspace table is granted to the REST API's roles (anon reads,
 * authenticated reads and writes: scripts/sql/postgrest-ddl-sync.sql), so
 * row-level security is the only boundary. A signed-in end user could add
 * themselves to another owner's organization with any role, or write an
 * invitation into it; joining opens every table the org_members rule scopes to
 * that organization. And accept-invite read the invitation with no session
 * claims, which under the application role found none.
 *
 * Now enable_teams installs the teams rules (lib/services/workspace-rls.ts),
 * accept-invite reads and writes as the service role in one transaction that
 * locks the invitation, and scripts/secure-teams-tables.ts (secureTeamsTables)
 * brings existing projects in line, leaving a rule a person chose alone.
 *
 * Reads and writes run as the REST API's own roles, NOSUPERUSER NOBYPASSRLS,
 * with production's grants, so these are the API's answers. The route runs as
 * a NOSUPERUSER NOBYPASSRLS member of the role that owns the tables, which is
 * production's application role (the project's client takes that role around
 * each call, as in __tests__/auth/end-user-token-paths.test.ts). Otherwise only
 * PostgREST's schema registry and the Cloud plan are stubbed.
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER', logRetentionDays: 30 }) }
})
jest.mock('@/lib/postgrest/registration', () => {
  const actual = jest.requireActual('@/lib/postgrest/registration')
  return {
    ...actual,
    registerSchemaByName: async (schema: string) => ({ registered: true, schema }),
    ensureSchemaRegistered: async (projectId: string) => ({ registered: true, schema: `workspace_${projectId}` }),
    unregisterSchema: async () => {},
  }
})

/** The role the project's client runs as while the route is called; empty otherwise. */
const mockPremise = { role: '' }
jest.mock('@/lib/data-plane/regional', () => {
  const actual = jest.requireActual('@/lib/data-plane/regional')
  // Each call is a transaction that first takes the role, as every statement
  // runs as the application role in production. Nothing else is changed.
  const asRole = (db: any) => {
    const scoped = (run: (tx: any) => Promise<unknown>) =>
      db.$transaction(async (tx: any) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${mockPremise.role}`)
        return run(tx)
      })
    return {
      $queryRaw: (...args: any[]) => scoped((tx) => tx.$queryRaw(...args)),
      $queryRawUnsafe: (...args: any[]) => scoped((tx) => tx.$queryRawUnsafe(...args)),
      $executeRaw: (...args: any[]) => scoped((tx) => tx.$executeRaw(...args)),
      $executeRawUnsafe: (...args: any[]) => scoped((tx) => tx.$executeRawUnsafe(...args)),
      $transaction: (run: any) => (Array.isArray(run) ? Promise.all(run) : scoped(run)),
    }
  }
  return {
    ...actual,
    workspaceRawClient: async (projectId: string) => {
      const db = await actual.workspaceRawClient(projectId)
      return mockPremise.role ? asRole(db) : db
    },
  }
})

import '@/tests/helpers/real-web-standard'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { executeAction } from '@/lib/ai/minimal-executor'
import { forgetProtection } from '@/lib/branches/protection'
import { withChangeAttribution } from '@/lib/changes/attribution'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { inferRlsPlan } from '@/lib/services/rls-ownership'
import { applyPermissionPolicy, secureTeamsTables } from '@/lib/services/workspace-rls'
import { jwtClaimsJson } from '@/lib/services/rls-session'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

type Handler = (request: NextRequest, context: { params: Promise<any> }) => Promise<Response>

const TABLES = ['organizations', 'organization_members', 'organization_invitations'] as const
const TEAMS_RULES = ['backenly_teams_delete', 'backenly_teams_insert', 'backenly_teams_select', 'backenly_teams_update']
const OWN_ROWS = ['backenly_own_rows_delete', 'backenly_own_rows_insert', 'backenly_own_rows_select', 'backenly_own_rows_update']
const INVITER_RULE = "invited_by_user_id::text = backenly_jwt_claim('sub')"

const tag = crypto.randomBytes(4).toString('hex')
const jwtSecret = crypto.randomBytes(32).toString('hex')
/** Owns an organization. */
const olivia = { id: crypto.randomUUID(), email: `olivia-${tag}@example.test` }
/** Is invited to it. */
const ines = { id: crypto.randomUUID(), email: `ines-${tag}@example.test` }
/** Belongs to neither, and tries. */
const mallory = { id: crypto.randomUUID(), email: `mallory-${tag}@example.test` }

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

let ownerId = ''
let projectId = ''
let schema = ''
let premiseRole = ''
let acceptInvite: Handler
let orgId = ''
let inviteToken = ''

const T = (table: string) => `"${schema}"."${table}"`
const ddl = (sql: string, ...values: unknown[]) => prisma.$executeRawUnsafe(sql, ...values)

/** Run as a REST API role, with the claims PostgREST would set. */
async function as<R>(role: 'anon' | 'authenticated', userId: string | null, sql: string, ...values: unknown[]): Promise<R[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`)
    await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, jwtClaimsJson({ userId }))
    return tx.$queryRawUnsafe<R[]>(sql, ...values)
  })
}
const asUser = <R>(userId: string, sql: string, ...values: unknown[]) => as<R>('authenticated', userId, sql, ...values)

async function policies(table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT policyname::text AS name FROM pg_policies WHERE schemaname = $1 AND tablename = $2 ORDER BY 1`,
    schema,
    table,
  )
  return rows.map((r) => r.name)
}

async function forced(table: string): Promise<boolean> {
  const [row] = await prisma.$queryRawUnsafe<Array<{ forced: boolean }>>(
    `SELECT relforcerowsecurity AS forced FROM pg_class WHERE oid = to_regclass($1)`,
    T(table),
  )
  return row?.forced ?? false
}

/** Production's grants to the REST API roles, for every table now in the schema. */
async function grantRestRoles(): Promise<void> {
  await ddl(`GRANT USAGE ON SCHEMA "${schema}" TO anon, authenticated, service_role`)
  await ddl(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO authenticated, service_role`)
  await ddl(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO anon`)
}

const tokenFor = (user: { id: string; email: string }) =>
  jwt.sign({ userId: user.id, email: user.email, projectId, role: 'user', jti: crypto.randomUUID() }, jwtSecret, {
    algorithm: 'HS256',
    expiresIn: '1h',
  })

/** POST /api/v1/{projectId}/orgs/accept-invite, the project's client running as the application role's premise. */
async function accept(user: { id: string; email: string }, token: string) {
  mockPremise.role = premiseRole
  try {
    const res = await acceptInvite(
      new NextRequest(`https://backenly.test/api/v1/${projectId}/orgs/accept-invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-token': tokenFor(user) },
        body: JSON.stringify({ token }),
      }),
      { params: Promise.resolve({ projectId }) },
    )
    return { status: res.status, body: (await res.json()) as any }
  } finally {
    mockPremise.role = ''
  }
}

/** An invitation written as the service role, as a server would. */
async function invitation(email: string, expires: 'tomorrow' | 'yesterday'): Promise<string> {
  const token = crypto.randomBytes(16).toString('hex')
  await ddl(
    `INSERT INTO ${T('organization_invitations')} (organization_id, email, role, token, invited_by_user_id, expires_at)
     VALUES ($1::uuid, $2, 'member', $3, $4::uuid, NOW() ${expires === 'tomorrow' ? '+' : '-'} INTERVAL '1 day')`,
    orgId,
    email,
    token,
    olivia.id,
  )
  return token
}

const teamsOn = () => executeAction({ action: 'ENABLE_TEAMS', params: {} }, projectId, undefined, 0, undefined, false)

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  // jest.setup.js sets integration mode, which reads the graph from memory and
  // skips the change ledger. enable_teams is tested as the product runs it.
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  ;({ POST: acceptInvite } = (await import('@/app/api/v1/[projectId]/orgs/accept-invite/route')) as unknown as { POST: Handler })

  // The REST API's roles. Cluster-wide, so created only when absent and never
  // dropped; every grant made to them here is on a schema that is dropped.
  await ddl(`DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
    END $$`)

  ownerId = (await prisma.user.create({
    data: { email: `teams-access-${tag}@example.test`, password: 'not-a-real-hash', name: 'Teams Access' },
  })).id
  const project = await createProvisionedProject({ name: 'teams-tables-access', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  // A new Cloud project starts protected; this suite changes production, as an
  // owner who turned protection off does. A signing secret of the legacy
  // plaintext form, which sign-in still accepts, so the suite can sign tokens.
  await prisma.project.update({ where: { id: projectId }, data: { protectedProduction: false, jwtSecret } })
  forgetProtection(projectId)

  const r = await teamsOn()
  expect({ success: r.success, message: r.message }).toMatchObject({ success: true })
  expect((r as any).change?.status).toBe('healthy')

  await grantRestRoles()
  for (const user of [olivia, ines, mallory]) {
    await ddl(`INSERT INTO ${T('users')} (id, email, password) VALUES ($1::uuid, $2, 'x')`, user.id, user.email)
  }

  // The application role's premise: no superuser, no BYPASSRLS, a member of
  // the role that owns the tables, so held to their forced row-level security.
  const [who] = await prisma.$queryRawUnsafe<Array<{ rolsuper: boolean; user: string }>>(
    `SELECT rolsuper, current_user AS "user" FROM pg_roles WHERE rolname = current_user`,
  )
  if (who.rolsuper) {
    await ddl(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backenly_rls_premise') THEN
        CREATE ROLE backenly_rls_premise NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$`)
    await ddl(`GRANT "${who.user}" TO backenly_rls_premise`)
    premiseRole = 'backenly_rls_premise'
  }
}, 240_000)

afterAll(async () => {
  mockPremise.role = ''
  const vaults = await prisma.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`,
  ).catch(() => [])
  for (const v of vaults) await ddl(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await ddl(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
}, 180_000)

describe('the premise', () => {
  it('the REST API roles are neither superusers nor exempt from row-level security', async () => {
    const roles = await prisma.$queryRawUnsafe<Array<{ name: string; rolsuper: boolean; rolbypassrls: boolean }>>(
      `SELECT rolname::text AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('anon', 'authenticated') ORDER BY 1`,
    )
    expect(roles).toEqual([
      { name: 'anon', rolsuper: false, rolbypassrls: false },
      { name: 'authenticated', rolsuper: false, rolbypassrls: false },
    ])
  })

  it('enable_teams leaves each table with the teams rules, forced', async () => {
    for (const table of TABLES) {
      expect({ table, rules: await policies(table), forced: await forced(table) }).toEqual({ table, rules: TEAMS_RULES, forced: true })
    }
  })

  it('the inference gives each of them the teams rules', async () => {
    for (const table of TABLES) expect((await inferRlsPlan(projectId, table)).kind).toBe('teams')
  })
})

describe('an owner', () => {
  it("creates an organization and the organization's first, owner membership", async () => {
    const [org] = await asUser<{ id: string }>(
      olivia.id,
      `INSERT INTO ${T('organizations')} (name, slug, owner_user_id) VALUES ('Acme', $1, $2::uuid) RETURNING id::text AS id`,
      `acme-${tag}`,
      olivia.id,
    )
    orgId = org.id
    const membership = await asUser<{ role: string }>(
      olivia.id,
      `INSERT INTO ${T('organization_members')} (organization_id, user_id, role) VALUES ($1::uuid, $2::uuid, 'owner') RETURNING role`,
      orgId,
      olivia.id,
    )
    expect(membership).toEqual([{ role: 'owner' }])
  })

  it('invites a user, recorded as the inviter', async () => {
    inviteToken = crypto.randomBytes(16).toString('hex')
    const rows = await asUser<{ email: string }>(
      olivia.id,
      `INSERT INTO ${T('organization_invitations')} (organization_id, email, role, token, invited_by_user_id, expires_at)
       VALUES ($1::uuid, $2, 'member', $3, $4::uuid, NOW() + INTERVAL '1 day') RETURNING email`,
      orgId,
      ines.email,
      inviteToken,
      olivia.id,
    )
    expect(rows).toEqual([{ email: ines.email }])
  })

  it('cannot record someone else as the inviter', async () => {
    await expect(
      asUser(
        olivia.id,
        `INSERT INTO ${T('organization_invitations')} (organization_id, email, role, token, invited_by_user_id)
         VALUES ($1::uuid, 'someone@example.test', 'member', $2, $3::uuid)`,
        orgId,
        crypto.randomBytes(16).toString('hex'),
        mallory.id,
      ),
    ).rejects.toThrow(/row-level security/)
  })

  it('reads the organization and its invitations', async () => {
    expect(await asUser(olivia.id, `SELECT id::text AS id FROM ${T('organizations')}`)).toEqual([{ id: orgId }])
    expect(await asUser(olivia.id, `SELECT token FROM ${T('organization_invitations')}`)).toEqual([{ token: inviteToken }])
  })
})

describe('another signed-in end user', () => {
  it("cannot add themselves to another owner's organization, with any role", async () => {
    for (const role of ['owner', 'admin', 'member']) {
      await expect(
        asUser(
          mallory.id,
          `INSERT INTO ${T('organization_members')} (organization_id, user_id, role) VALUES ($1::uuid, $2::uuid, $3)`,
          orgId,
          mallory.id,
          role,
        ),
      ).rejects.toThrow(/row-level security/)
    }
  })

  it("cannot write an invitation into another owner's organization", async () => {
    await expect(
      asUser(
        mallory.id,
        `INSERT INTO ${T('organization_invitations')} (organization_id, email, role, token, invited_by_user_id, expires_at)
         VALUES ($1::uuid, $2, 'admin', $3, $4::uuid, NOW() + INTERVAL '1 day')`,
        orgId,
        mallory.email,
        crypto.randomBytes(16).toString('hex'),
        mallory.id,
      ),
    ).rejects.toThrow(/row-level security/)
  })

  it('reads none of its rows and changes none', async () => {
    for (const table of TABLES) expect(await asUser(mallory.id, `SELECT * FROM ${T(table)}`)).toEqual([])
    expect(
      await asUser(mallory.id, `UPDATE ${T('organizations')} SET owner_user_id = $1::uuid WHERE id = $2::uuid RETURNING id`, mallory.id, orgId),
    ).toEqual([])
    expect(await asUser(mallory.id, `DELETE FROM ${T('organization_invitations')} WHERE organization_id = $1::uuid RETURNING id`, orgId)).toEqual([])
    expect(await asUser(mallory.id, `DELETE FROM ${T('organization_members')} WHERE organization_id = $1::uuid RETURNING id`, orgId)).toEqual([])
  })
})

describe('the publishable key', () => {
  it('reads none of the three tables', async () => {
    for (const table of TABLES) {
      const [{ n }] = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM ${T(table)}`)
      expect({ table, rows: n > 0 }).toEqual({ table, rows: true })
      expect(await as('anon', null, `SELECT * FROM ${T(table)}`)).toEqual([])
    }
  })
})

describe('the invitee', () => {
  it('cannot accept an invitation addressed to someone else', async () => {
    const out = await accept(mallory, inviteToken)
    expect(out.status).toBe(403)
    expect(out.body.code).toBe('INVITE_EMAIL_MISMATCH')
  }, 60_000)

  it('joins through POST /orgs/accept-invite, run as the application role', async () => {
    const out = await accept(ines, inviteToken)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true, organizationId: orgId, role: 'member' })
    const [invite] = await prisma.$queryRawUnsafe<Array<{ accepted: boolean }>>(
      `SELECT accepted_at IS NOT NULL AS accepted FROM ${T('organization_invitations')} WHERE token = $1`,
      inviteToken,
    )
    expect(invite.accepted).toBe(true)
    expect(await asUser(ines.id, `SELECT id::text AS id FROM ${T('organizations')}`)).toEqual([{ id: orgId }])
    expect(await asUser(ines.id, `SELECT role FROM ${T('organization_members')}`)).toEqual([{ role: 'member' }])
  }, 60_000)

  it('cannot accept the same invitation again', async () => {
    const out = await accept(ines, inviteToken)
    expect(out.status).toBe(409)
    expect(out.body.code).toBe('INVITE_ALREADY_ACCEPTED')
  }, 60_000)

  it('cannot accept an expired invitation', async () => {
    const out = await accept(mallory, await invitation(mallory.email, 'yesterday'))
    expect(out.status).toBe(410)
    expect(out.body.code).toBe('INVITE_EXPIRED')
    expect(await asUser(mallory.id, `SELECT * FROM ${T('organizations')}`)).toEqual([])
  }, 60_000)

  it("cannot raise their own role, read the organization's invitations, or remove another member", async () => {
    expect(await asUser(ines.id, `UPDATE ${T('organization_members')} SET role = 'owner' WHERE user_id = $1::uuid RETURNING role`, ines.id)).toEqual([])
    expect(await asUser(ines.id, `SELECT token FROM ${T('organization_invitations')}`)).toEqual([])
    expect(await asUser(ines.id, `DELETE FROM ${T('organization_members')} WHERE user_id = $1::uuid RETURNING id`, olivia.id)).toEqual([])
  })
})

describe('a member', () => {
  it('leaves by deleting their membership, and then reads the organization no more', async () => {
    const left = await asUser(ines.id, `DELETE FROM ${T('organization_members')} WHERE user_id = $1::uuid RETURNING role`, ines.id)
    expect(left).toEqual([{ role: 'member' }])
    expect(await asUser(ines.id, `SELECT * FROM ${T('organizations')}`)).toEqual([])
    expect(await asUser(olivia.id, `SELECT role FROM ${T('organization_members')}`)).toEqual([{ role: 'owner' }])
  })
})

describe('a project whose teams tables have the rules releases before the fix gave them', () => {
  beforeAll(async () => {
    // organizations: row-level security off, as tables made before the users
    // foreign keys were left; organization_members: its owner's rows, as the
    // inference gave it, applied by Backenly, not on anyone's request.
    for (const p of TEAMS_RULES) await ddl(`DROP POLICY IF EXISTS ${p} ON ${T('organizations')}`)
    await ddl(`ALTER TABLE ${T('organizations')} NO FORCE ROW LEVEL SECURITY`)
    await ddl(`ALTER TABLE ${T('organizations')} DISABLE ROW LEVEL SECURITY`)
    await prisma.permissionPolicy.deleteMany({ where: { projectId, tableName: 'organizations' } })
    const own = await applyPermissionPolicy(projectId, { tableName: 'organization_members', template: 'own_rows', userIdColumn: 'user_id' })
    expect(own).toMatchObject({ success: true })
    // organization_invitations: a rule a person chose in the console.
    const chosen = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
      executeAction(
        {
          action: 'SET_PERMISSION',
          params: {
            tableName: 'organization_invitations',
            template: 'custom',
            commands: { select: INVITER_RULE, insert: INVITER_RULE, update: INVITER_RULE, delete: INVITER_RULE },
          },
        },
        projectId,
        undefined,
        0,
        undefined,
        false,
      ),
    )
    expect({ success: chosen.success, message: chosen.message }).toMatchObject({ success: true })
  }, 120_000)

  it('the premise: under those rules a signed-in user joins another owner\'s organization as its admin', async () => {
    expect(await policies('organization_members')).toEqual(OWN_ROWS)
    const joined = await asUser<{ role: string }>(
      mallory.id,
      `INSERT INTO ${T('organization_members')} (organization_id, user_id, role) VALUES ($1::uuid, $2::uuid, 'admin') RETURNING role`,
      orgId,
      mallory.id,
    )
    expect(joined).toEqual([{ role: 'admin' }])
    await ddl(`DELETE FROM ${T('organization_members')} WHERE user_id = $1::uuid`, mallory.id)
  })

  it("are found and reported, the person's rule kept, and nothing is changed", async () => {
    const found = await secureTeamsTables(projectId, { apply: false })
    expect(found).toEqual([
      {
        schema,
        tables: ['organizations', 'organization_members'],
        kept: [{ table: 'organization_invitations', reason: expect.stringContaining('backenly_custom_select') }],
        blocked: [],
        secured: false,
      },
    ])
    expect(await policies('organizations')).toEqual([])
    expect(await policies('organization_members')).toEqual(OWN_ROWS)
  }, 60_000)

  it("get the teams rules as one change Backenly made, and the person's rule stays", async () => {
    const done = await secureTeamsTables(projectId, { apply: true })
    expect(done).toEqual([
      {
        schema,
        tables: ['organizations', 'organization_members'],
        kept: [{ table: 'organization_invitations', reason: expect.any(String) }],
        blocked: [],
        secured: true,
      },
    ])
    for (const table of ['organizations', 'organization_members']) {
      expect({ table, rules: await policies(table), forced: await forced(table) }).toEqual({ table, rules: TEAMS_RULES, forced: true })
    }
    expect(await policies('organization_invitations')).toEqual([
      'backenly_custom_delete', 'backenly_custom_insert', 'backenly_custom_select', 'backenly_custom_update',
    ])
    const change = await prisma.backendChange.findFirst({
      where: { projectId, title: 'Set the teams rules on organizations, organization_members' },
      select: { source: true, status: true },
    })
    expect(change).toEqual({ source: 'system', status: 'healthy' })
  }, 120_000)

  it('after which the self-join is refused, and there is nothing left to secure', async () => {
    await expect(
      asUser(
        mallory.id,
        `INSERT INTO ${T('organization_members')} (organization_id, user_id, role) VALUES ($1::uuid, $2::uuid, 'admin')`,
        orgId,
        mallory.id,
      ),
    ).rejects.toThrow(/row-level security/)
    const again = await secureTeamsTables(projectId, { apply: false })
    expect(again).toEqual([
      { schema, tables: [], kept: [{ table: 'organization_invitations', reason: expect.any(String) }], blocked: [], secured: false },
    ])
  }, 60_000)

  it('enable_teams run again gives all three the teams rules, as one verified change', async () => {
    await ddl(`DROP POLICY IF EXISTS backenly_teams_select ON ${T('organizations')}`)
    const r = await teamsOn()
    expect({ success: r.success, message: r.message }).toMatchObject({ success: true })
    expect((r as any).change?.status).toBe('healthy')
    for (const table of TABLES) {
      expect({ table, rules: await policies(table), forced: await forced(table) }).toEqual({ table, rules: TEAMS_RULES, forced: true })
    }
  }, 240_000)
})
