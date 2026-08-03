/**
 * Invariant probe fixtures — the remaining detectors, proven able to fire.
 *
 * Companion to security-probe-fixtures.spec.ts, which covers the four where
 * being wrong is a breach or a total outage. These seven are the rest of the
 * catalogue in lib/autonomy/desired-state.ts that had never been observed
 * producing a finding in CI or on production:
 *
 *   detectMissingFkIndexes        the silent performance cliff on joins
 *   detectMissingHotPathIndexes   the same cliff on created_at / status / email
 *   detectOrphanTables            a table the platform cannot see, holding real data
 *   detectShadowMutations         live schema drifted from what the AI built
 *   checkAuthIntegrity            auth wired wrong while the app has users
 *   detectRuntimeEngineMismatch   policies reading an identity nothing sets
 *   verifyWorkflows               the seam between components, not the parts
 *
 * Same contract as its companion: build the violating state for real, assert the
 * probe fires, then assert it goes quiet once repaired. No mocks — the probes
 * ARE the SQL, so mocking would test the mock.
 *
 * Several of these carry an EVIDENCE GATE, and the gate is the interesting part.
 * `checkAuthIntegrity` and `verifyWorkflows` both refuse to report anything until
 * end-user auth is demonstrably in use, because `users` ships as scaffolding on
 * every freshly-named project — an ungated probe matched universally and called
 * brand-new backends broken before their owner had connected an agent. The
 * fixtures below assert the silence as carefully as the firing, since a detector
 * that cries wolf on every new project is how a queue teaches its reader to
 * ignore it.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

import { detectMissingFkIndexes, detectShadowMutations, checkAuthIntegrity } from '@/lib/core/drift-detector'
import { detectMissingHotPathIndexes } from '@/lib/autonomy/invariant-probes'
import { detectOrphanTables } from '@/lib/services/workspace-observer'
import { detectRuntimeEngineMismatch, compareEngineToPolicies } from '@/lib/autonomy/engine-conformance'
import { verifyWorkflows } from '@/lib/core/workflow-verifier'
import { captureSchemaSnapshot } from '@/lib/services/workspace-schema-snapshot'
import {
  detectDataPlaneNotAnswering,
  recordContractSweepResult,
} from '@/lib/autonomy/data-plane-liveness'
import { computeDesiredStateDiff, summarizeDesiredState } from '@/lib/autonomy/desired-state'

const prisma = new PrismaClient()

let projectId: string
let userId: string
let schema: string

const q = (sql: string) => prisma.$executeRawUnsafe(sql)

const forTable = (findings: Array<{ details?: unknown }>, table: string) =>
  findings.find((f) => (f.details as any)?.tableName === table)

beforeAll(async () => {
  userId = randomUUID()
  projectId = randomUUID()
  schema = `workspace_${projectId}`

  await prisma.user.create({
    data: {
      id: userId,
      email: `invariant-probes+${userId.slice(0, 8)}@backenly.test`,
      name: 'invariant probe fixtures',
      password: 'not-a-real-hash',
    },
  })
  await prisma.project.create({
    data: { id: projectId, name: 'invariant-probe-fixtures', userId },
  })
  await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
}, 120_000)

afterAll(async () => {
  await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
  await prisma.$disconnect()
}, 120_000)

// ── relationships_are_indexed ────────────────────────────────────────────────

describe('detectMissingFkIndexes', () => {
  const table = 'line_items'

  it('FIRES for an unindexed *_id column', async () => {
    await q(`CREATE TABLE "${schema}"."${table}" (id uuid PRIMARY KEY, order_id uuid, sku text)`)

    const hit = (await detectMissingFkIndexes(projectId)).find(
      (f) => (f.details as any)?.tableName === table && (f.details as any)?.columnName === 'order_id',
    )

    expect(hit).toBeDefined()
    expect(hit!.type).toBe('missing_fk_index')
  }, 120_000)

  it('goes QUIET once the column is indexed', async () => {
    await q(`CREATE INDEX idx_${table}_order_id ON "${schema}"."${table}" (order_id)`)

    const hit = (await detectMissingFkIndexes(projectId)).find(
      (f) => (f.details as any)?.tableName === table && (f.details as any)?.columnName === 'order_id',
    )
    expect(hit).toBeUndefined()
  }, 120_000)

  it('never reports the primary key column itself', async () => {
    // `id` ends in "id" but is the PK and always indexed. The query excludes it
    // by name; without that every table on every project would report a gap.
    const hit = (await detectMissingFkIndexes(projectId)).find(
      (f) => (f.details as any)?.tableName === table && (f.details as any)?.columnName === 'id',
    )
    expect(hit).toBeUndefined()
  }, 120_000)
})

// ── hot_path_columns_are_indexed ─────────────────────────────────────────────

describe('detectMissingHotPathIndexes', () => {
  const table = 'articles'

  it('FIRES for unindexed common filter columns', async () => {
    // These look fast on day one and turn every request into a full table scan
    // once the table has real data.
    await q(`CREATE TABLE "${schema}"."${table}" (
      id uuid PRIMARY KEY, status text, slug text, created_at timestamptz)`)

    const hits = (await detectMissingHotPathIndexes(projectId)).filter(
      (f) => (f.details as any)?.tableName === table,
    )

    expect(hits.length).toBeGreaterThan(0)
    const columns = hits.map((f) => (f.details as any).columnName)
    expect(columns).toEqual(expect.arrayContaining(['status']))
  }, 120_000)

  it('goes QUIET for a column once it is indexed', async () => {
    await q(`CREATE INDEX idx_${table}_status ON "${schema}"."${table}" (status)`)

    const hit = (await detectMissingHotPathIndexes(projectId)).find(
      (f) => (f.details as any)?.tableName === table && (f.details as any)?.columnName === 'status',
    )
    expect(hit).toBeUndefined()
  }, 120_000)

  // Regression: the candidate list was snake_case only, so this probe was
  // structurally incapable of firing on the platform's OWN tables — every table
  // created through the builder gets quoted camelCase "createdAt"/"updatedAt"
  // (lib/ai/minimal-executor.ts), and reported no indexable column forever. The
  // sibling detector in lib/ai/infra-intelligence.ts was fixed for this in
  // 7851f40e; this copy was missed.
  describe('camelCase timestamps (builder-created tables)', () => {
    const camel = 'camel_articles'

    it('FIRES for an unindexed "createdAt"', async () => {
      await q(`CREATE TABLE "${schema}"."${camel}" (
        id uuid PRIMARY KEY, "createdAt" timestamptz, "updatedAt" timestamptz)`)

      const columns = (await detectMissingHotPathIndexes(projectId))
        .filter((f) => (f.details as any)?.tableName === camel)
        .map((f) => (f.details as any).columnName)

      expect(columns).toEqual(expect.arrayContaining(['createdAt']))
    }, 120_000)

    it('goes QUIET once the camelCase column is indexed', async () => {
      // Quoted on purpose — unquoted createdAt folds to lowercase and would
      // index a column that does not exist.
      await q(`CREATE INDEX idx_${camel}_created ON "${schema}"."${camel}" ("createdAt")`)

      const hit = (await detectMissingHotPathIndexes(projectId)).find(
        (f) => (f.details as any)?.tableName === camel && (f.details as any)?.columnName === 'createdAt',
      )
      expect(hit).toBeUndefined()
    }, 120_000)
  })
})

// ── live_tables_are_adopted ──────────────────────────────────────────────────

describe('detectOrphanTables', () => {
  const table = 'made_by_psql'

  it('FIRES for a live table the platform has no record of', async () => {
    // A READ_WRITE connection string is a product feature, so tables created
    // from psql are expected. Until adopted the table has no RLS, no API
    // contract and no backup entry — real data the platform cannot see.
    await q(`CREATE TABLE "${schema}"."${table}" (id uuid PRIMARY KEY, payload jsonb)`)

    const hit = forTable(await detectOrphanTables(projectId), table)

    expect(hit).toBeDefined()
    expect(hit!.type).toBe('orphan_table')
  }, 120_000)

  it('goes QUIET once the table is registered with the platform', async () => {
    await prisma.table.create({
      data: { projectId, name: table, schema, description: 'adopted by fixture' },
    })

    expect(forTable(await detectOrphanTables(projectId), table)).toBeUndefined()
  }, 120_000)

  it('never reports the platform-managed users table', async () => {
    await q(`CREATE TABLE "${schema}"."users" (id uuid PRIMARY KEY, email text, password text)`)

    expect(forTable(await detectOrphanTables(projectId), 'users')).toBeUndefined()
  }, 120_000)
})

// ── live_schema_matches_intent ───────────────────────────────────────────────

describe('detectShadowMutations', () => {
  it('stays silent with no snapshot to compare against', async () => {
    // No baseline means no opinion. Reporting drift here would flag every
    // column on every project that has never been snapshotted.
    expect(await detectShadowMutations(projectId)).toEqual([])
  }, 120_000)

  it('FIRES for a column added outside the platform after the snapshot', async () => {
    const snapshot = await captureSchemaSnapshot(projectId, 'post_migration')
    expect(snapshot).not.toBeNull()

    await q(`ALTER TABLE "${schema}"."articles" ADD COLUMN secret_flag boolean DEFAULT false`)

    const hit = forTable(await detectShadowMutations(projectId), 'articles')

    expect(hit).toBeDefined()
    expect(hit!.type).toBe('shadow_mutation')
    expect(JSON.stringify(hit!.details)).toContain('secret_flag')
  }, 120_000)

  it('goes QUIET once a fresh snapshot adopts the change', async () => {
    await captureSchemaSnapshot(projectId, 'post_migration')

    expect(forTable(await detectShadowMutations(projectId), 'articles')).toBeUndefined()
  }, 120_000)
})

// ── runtime_engine_matches_rls_contract ──────────────────────────────────────

describe('detectRuntimeEngineMismatch', () => {
  const table = 'engine_probe'

  it('treats a project with no policies as conformant, not mismatched', () => {
    // Pure decision, no database: nothing depends on the identity contract when
    // there are no policies, and reporting those would bury the real cases.
    expect(compareEngineToPolicies(0, 0).mismatched).toBe(false)
    expect(compareEngineToPolicies(0, 5).mismatched).toBe(false)
    expect(compareEngineToPolicies(1, 5).mismatched).toBe(true)
  })

  it('FIRES for a policy written against the legacy app.* GUCs', async () => {
    // PostgREST sets request.jwt.claims and never sets app.*. A policy reading
    // those evaluates against an identity that was never set, matches no rows,
    // and the API answers 200 with an empty array. Nothing errors, no log line
    // appears — monitoring sees healthy traffic while the customer sees their
    // data gone.
    await q(`CREATE TABLE "${schema}"."${table}" (id uuid PRIMARY KEY, user_id uuid)`)
    await q(`ALTER TABLE "${schema}"."${table}" ENABLE ROW LEVEL SECURITY`)
    await q(`CREATE POLICY engine_probe_legacy ON "${schema}"."${table}"
             FOR SELECT USING (user_id::text = current_setting('app.current_user_id', true))`)

    const findings = await detectRuntimeEngineMismatch(projectId)

    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].type).toBe('runtime_engine_mismatch')
  }, 120_000)

  it('goes QUIET once the policy reads the claim the engine actually sets', async () => {
    await q(`DROP POLICY engine_probe_legacy ON "${schema}"."${table}"`)
    await q(`CREATE POLICY engine_probe_jwt ON "${schema}"."${table}"
             FOR SELECT
             USING (user_id::text = current_setting('request.jwt.claims', true)::json->>'sub')`)

    expect(await detectRuntimeEngineMismatch(projectId)).toEqual([])
  }, 120_000)
})

// ── auth_subsystem_is_intact ─────────────────────────────────────────────────

describe('checkAuthIntegrity', () => {
  it('stays silent on a project with no auth usage, whatever its provisioning state', async () => {
    // The evidence gate. jwtSecret and the users table are provisioned lazily,
    // so their absence on an unused project is a state, not a failure. An
    // ungated version put a permanent critical on every new project.
    const findings = await checkAuthIntegrity(projectId)
    expect(findings.find((f) => f.type === 'auth_jwt_missing')).toBeUndefined()
  }, 120_000)

  it('FIRES auth_jwt_missing once auth is in use but no secret can sign a token', async () => {
    // A real identity is the strongest evidence auth is in use. With one
    // present and no jwtSecret, every end-user sign-in silently fails.
    await q(`INSERT INTO "${schema}"."users" (id, email, password)
             VALUES ('${randomUUID()}', 'end-user@example.com', 'hash')`)
    await prisma.project.update({ where: { id: projectId }, data: { jwtSecret: null } })

    const hit = (await checkAuthIntegrity(projectId)).find((f) => f.type === 'auth_jwt_missing')

    expect(hit).toBeDefined()
    expect(hit!.severity).toBe('critical')
  }, 120_000)

  it('goes QUIET once the project has a signing secret', async () => {
    await prisma.project.update({
      where: { id: projectId },
      data: { jwtSecret: 'fixture-secret-not-a-real-key' },
    })

    const hit = (await checkAuthIntegrity(projectId)).find((f) => f.type === 'auth_jwt_missing')
    expect(hit).toBeUndefined()
  }, 120_000)

  it('FIRES oauth_redirect_uri_missing for a provider with no redirect URI', async () => {
    await prisma.workspaceOAuthConfig.create({
      data: {
        projectId,
        provider: 'google',
        clientId: 'fixture-client-id',
        clientSecret: 'fixture-client-secret-not-real',
        enabled: true,
      },
    })

    const hit = (await checkAuthIntegrity(projectId)).find(
      (f) => f.type === 'oauth_redirect_uri_missing',
    )

    expect(hit).toBeDefined()
    expect((hit!.details as any).provider).toBe('google')
  }, 120_000)

  it('goes QUIET once the redirect URI is set', async () => {
    await prisma.workspaceOAuthConfig.updateMany({
      where: { projectId, provider: 'google' },
      data: { redirectUri: 'https://example.test/auth/callback' },
    })

    const hit = (await checkAuthIntegrity(projectId)).find(
      (f) => f.type === 'oauth_redirect_uri_missing',
    )
    expect(hit).toBeUndefined()
  }, 120_000)
})

// ── declared_workflows_still_work ────────────────────────────────────────────

describe('verifyWorkflows', () => {
  it('FIRES for an auth flow in use but missing its components', async () => {
    // The check that sees the seam rather than the parts: signup → verify →
    // login breaks when any one component is removed, and each piece still
    // looks healthy on its own. A real identity now exists (inserted above), so
    // the workflow is in use; no PermissionPolicy protects `users`.
    const findings = await verifyWorkflows(projectId)
    const hit = findings.find((f) => (f.details as any)?.workflow === 'user_auth_flow')

    expect(hit).toBeDefined()
    expect(hit!.type).toBe('workflow_broken')
    expect((hit!.details as any).missingComponents).toEqual(
      expect.arrayContaining(['rls_on_users']),
    )
  }, 120_000)

  it('locates workflow findings by workflow name, never by table', async () => {
    // gapIdentity keys these on details.workflow because they carry no
    // tableName. When it did not, every workflow_broken row shared the identity
    // `workflow_broken::`, so one still-broken workflow masked a second that had
    // genuinely healed and pinned its finding open forever.
    const hit = (await verifyWorkflows(projectId)).find(
      (f) => (f.details as any)?.workflow === 'user_auth_flow',
    )
    expect((hit!.details as any).tableName).toBeUndefined()
    expect(typeof (hit!.details as any).workflow).toBe('string')
  }, 120_000)

  it('goes QUIET once the missing component is in place', async () => {
    await prisma.permissionPolicy.create({
      data: {
        projectId,
        tableName: 'users',
        policyName: 'users_own_rows',
        operation: 'SELECT',
        role: 'authenticated',
        using: `id::text = current_setting('request.jwt.claims', true)::json->>'sub'`,
        enabled: true,
      },
    })

    const hit = (await verifyWorkflows(projectId)).find(
      (f) =>
        (f.details as any)?.workflow === 'user_auth_flow' &&
        ((f.details as any)?.missingComponents ?? []).includes('rls_on_users'),
    )
    expect(hit).toBeUndefined()
  }, 120_000)
})

// ── data_plane_is_answering ──────────────────────────────────────────────────

describe('detectDataPlaneNotAnswering', () => {
  // The invariant added because contract_surface_broken was ~80% of every real
  // production fault and was not in the catalogue at all — so the health verdict
  // could read "all guarantees hold" during a customer-facing outage.

  it('stays silent for a project with no tables', async () => {
    // runContractSweep selects `tables: { some: {} }`, so an unbuilt project is
    // never swept and never gets a heartbeat. That is a correct state, not an
    // unknown one. Without this branch every unbuilt project would report
    // "could not be checked" forever — and because reapInvariantFindings
    // refuses to reap when any probe errored, it would also freeze their
    // finding cleanup permanently.
    const ghost = randomUUID()
    const ghostUser = randomUUID()
    await prisma.user.create({
      data: {
        id: ghostUser,
        email: `dp-ghost+${ghostUser.slice(0, 8)}@backenly.test`,
        name: 'dp ghost',
        password: 'not-a-real-hash',
      },
    })
    await prisma.project.create({ data: { id: ghost, name: 'dp-ghost', userId: ghostUser } })

    expect(await detectDataPlaneNotAnswering(ghost)).toEqual([])

    await prisma.project.deleteMany({ where: { id: ghost } })
    await prisma.user.deleteMany({ where: { id: ghostUser } })
  }, 120_000)

  it('THROWS rather than reporting healthy when the sweep has never run', async () => {
    // This project has tables (created by the fixtures above) and no heartbeat.
    // Returning [] here would mean "verified answering", which is a claim
    // nothing supports — the exact laundering of silence into health that this
    // invariant exists to stop.
    await expect(detectDataPlaneNotAnswering(projectId)).rejects.toThrow(/never verified|unknown/i)
  }, 120_000)

  it('THROWS when the heartbeat is too old to mean anything', async () => {
    await recordContractSweepResult(projectId, [])
    await prisma.projectPreference.updateMany({
      where: { projectId, type: 'contract_liveness' },
      data: {
        value: JSON.stringify({
          verifiedAt: new Date(Date.now() - 4 * 3600_000).toISOString(),
          ok: true,
          brokenSurfaces: [],
        }),
      },
    })

    await expect(detectDataPlaneNotAnswering(projectId)).rejects.toThrow(/older than|unknown/i)
  }, 120_000)

  it('goes QUIET on a fresh heartbeat that says every surface answered', async () => {
    await recordContractSweepResult(projectId, [])

    expect(await detectDataPlaneNotAnswering(projectId)).toEqual([])
  }, 120_000)

  it('FIRES when the sweep recorded a broken surface, surfacing the rows it wrote', async () => {
    // The sweep is the single writer. This probe reads back what it recorded
    // rather than re-deriving gaps, so two components can never author the same
    // finding with identities that disagree.
    await prisma.healthFinding.create({
      data: {
        projectId,
        type: 'contract_surface_broken',
        severity: 'critical',
        status: 'pending_approval',
        autoFixed: false,
        details: { surface: 'db', detail: 'probe error: ECONNREFUSED', httpStatus: null },
      },
    })
    await recordContractSweepResult(projectId, ['db'])

    const findings = await detectDataPlaneNotAnswering(projectId)

    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].type).toBe('contract_surface_broken')
    expect((findings[0].details as any).surface).toBe('db')
    // Repair belongs to the sweep, which is single-flighted platform-wide.
    // A second fix closure here would be a second execution path.
    expect(findings[0].autoFixable).toBe(false)
  }, 120_000)

  it('makes the overall verdict refuse to say "healthy" during an outage', async () => {
    // The end-to-end point of the whole change.
    const report = await computeDesiredStateDiff(projectId)
    expect(report.satisfied).toBe(false)
    expect(summarizeDesiredState(report)).not.toContain('all guarantees hold')

    const liveness = report.invariants.find((i) => i.id === 'data_plane_is_answering')
    expect(liveness).toBeDefined()
    expect(liveness!.satisfied).toBe(false)
  }, 180_000)
})
