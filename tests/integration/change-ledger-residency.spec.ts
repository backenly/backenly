/**
 * A REGIONAL PROJECT'S CHANGE RECORD KEEPS STRUCTURE AT HOME, DEFINITIONS IN ITS REGION
 * ====================================================================================
 * The change ledger lives on the platform database, in the home region. Its
 * record of a change kept the catalog before and after it, which carries a
 * project's own text: function bodies, view queries, CHECK, policy, default
 * and generation expressions, index and trigger statements, table comments
 * and enum labels. For a project kept in another region that text stays
 * there (founders, 2026-10-19; lib/changes/residency.ts): the home record
 * keeps names, kinds, types, oids, flags and references, and a keyed digest of
 * each definition, and the region keeps the catalogs in its regional_bodies.
 *
 * This suite creates a second database as the stand-in for another region's,
 * installs the real regional table there (scripts/sql/regional-bodies.sql) and
 * the ledger's guard at home, and pins:
 *
 *   home record    no definition of a regional change, its restore or an
 *                  interrupted one appears on its rows, its events or its
 *                  audit entries; each object is still named, with a digest
 *   region         holds the definitions, under the change's id
 *   restore        works from the region's copy and puts every definition back
 *                  exactly
 *   integrity      a region's copy altered or missing is refused, and nothing
 *                  is restored from it
 *   home project   its record keeps its definitions, as before
 *
 * Real databases, real catalogs, real restores: nothing that carries the
 * property is mocked.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { Client } from 'pg'

import { prisma } from '@/lib/db/prisma'
import { withChangeAttribution, withGovernedChange } from '@/lib/changes/ledger'
import { closeChangeLockPool, readCatalogOn, withChangeLock } from '@/lib/changes/lock'
import { previewRecovery, reconcileChange, recoverChange } from '@/lib/changes/recovery'
import { catalogStructure, keepCatalogInRegion, newCatalogKey } from '@/lib/changes/residency'
import { disconnectRegionalClients, workspaceRawClient } from '@/lib/data-plane/regional'
import { getWorkspaceDatabaseNames } from '@/lib/services/databaseProvisioning'
import { closeAllWorkspacePools } from '@/lib/services/workspace-pool'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

jest.setTimeout(180_000)

const REGION_VARIABLE = 'DATABASE_URL_US_EAST_1'
const REGIONAL_DB = `backenly_ledger_${randomBytes(4).toString('hex')}`
/** In every definition this suite writes, so any copy of one can be found. */
const MARK = randomBytes(6).toString('hex')
const HOME_MARK = randomBytes(6).toString('hex')

const homeUrl = () => process.env.DATABASE_URL as string
function urlFor(database: string): string {
  const url = new URL(homeUrl())
  url.pathname = `/${database}`
  return url.toString()
}
const regionalUrl = urlFor(REGIONAL_DB)

async function rowsIn<T>(connectionString: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    return (await client.query(sql, params)).rows as T[]
  } finally {
    await client.end().catch(() => {})
  }
}
const run = async (connectionString: string, sql: string) => {
  await rowsIn(connectionString, sql)
}

let ownerId = ''
let regionalProject = ''
let homeProject = ''
let regionalDbCreated = false
const originalEngineMode = process.env.ENGINE_MODE

const schemaOf = (projectId: string) => getWorkspaceDatabaseNames(projectId).postgresSchema

/** The objects, each definition carrying `mark`. */
const createObjects = (s: string, mark: string) => [
  `CREATE TYPE "${s}".mood AS ENUM ('marker_enum_${mark}')`,
  `CREATE TABLE "${s}".notes (
     id serial PRIMARY KEY,
     owner text,
     note text DEFAULT 'MARKER_DEFAULT_${mark}',
     qty int,
     shout text GENERATED ALWAYS AS (upper(note) || 'MARKER_GENERATED_${mark}') STORED,
     CONSTRAINT notes_qty_check CHECK (qty IS NULL OR note <> 'MARKER_CHECK_${mark}')
   )`,
  `CREATE INDEX notes_partial ON "${s}".notes (owner) WHERE note <> 'MARKER_INDEX_${mark}'`,
  `ALTER TABLE "${s}".notes ENABLE ROW LEVEL SECURITY`,
  `CREATE POLICY notes_policy ON "${s}".notes USING (owner <> 'MARKER_POLICY_${mark}')`,
  `CREATE FUNCTION "${s}".stamp() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN NEW.owner := coalesce(NEW.owner, 'MARKER_FUNCTION_${mark}'); RETURN NEW; END
   $$`,
  `CREATE TRIGGER notes_stamp BEFORE INSERT ON "${s}".notes FOR EACH ROW
     WHEN (NEW.note IS DISTINCT FROM 'MARKER_TRIGGER_${mark}') EXECUTE FUNCTION "${s}".stamp()`,
  `COMMENT ON TABLE "${s}".notes IS 'MARKER_COMMENT_${mark}'`,
  `CREATE VIEW "${s}".notes_view AS SELECT id, 'MARKER_VIEW_${mark}'::text AS tag FROM "${s}".notes`,
]

/** Everything Change B removes; the policy stays, so its checks pass on their own. */
const dropObjects = (s: string) => [
  `DROP VIEW "${s}".notes_view`,
  `DROP TRIGGER notes_stamp ON "${s}".notes`,
  `DROP FUNCTION "${s}".stamp()`,
  `ALTER TABLE "${s}".notes DROP CONSTRAINT notes_qty_check`,
  `DROP INDEX "${s}".notes_partial`,
  `ALTER TABLE "${s}".notes ALTER COLUMN note DROP DEFAULT`,
  `COMMENT ON TABLE "${s}".notes IS NULL`,
  `DROP TYPE "${s}".mood`,
]

/** The definitions, as the region's own catalog renders them. */
async function definitionsIn(url: string, s: string) {
  const [d] = await rowsIn<Record<string, string | null>>(
    url,
    `SELECT
       (SELECT pg_get_viewdef(c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'notes_view') AS view,
       (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = 'stamp') AS function,
       (SELECT pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE n.nspname = $1 AND k.conname = 'notes_qty_check') AS "check",
       (SELECT pg_get_indexdef(c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'notes_partial') AS index,
       (SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND t.tgname = 'notes_stamp') AS trigger,
       (SELECT column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'notes' AND column_name = 'note') AS "default",
       (SELECT obj_description(c.oid, 'pg_class') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'notes') AS comment,
       (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = 'mood') AS labels`,
    [s],
  )
  return d
}

/**
 * Every home row of a project's change record that holds `mark`: the changes,
 * their events and the audit entries. The whole row is read as text, so no
 * column can hold a copy unseen.
 */
async function homeCopies(projectId: string, mark: string): Promise<Record<string, number>> {
  const count = async (table: string) =>
    Number(
      (await rowsIn<{ n: string }>(homeUrl(), `SELECT count(*)::text AS n FROM ${table} r WHERE r."projectId" = $1 AND r::text ILIKE $2`, [projectId, `%${mark}%`]))[0].n,
    )
  return {
    backend_changes: await count('backend_changes'),
    backend_change_events: await count('backend_change_events'),
    audit_logs: await count('audit_logs'),
  }
}
const NONE = { backend_changes: 0, backend_change_events: 0, audit_logs: 0 }

/** The region's copy of a change's catalogs. */
const regionalBody = async (changeId: string) =>
  (await rowsIn<{ projectId: string; payload: any }>(
    regionalUrl,
    `SELECT "projectId", "payload" FROM public.regional_bodies WHERE "kind" = 'change_catalog' AND "id" = $1`,
    [changeId],
  ))[0]

/** A change made in a project's own database, as the dashboard makes one. */
async function change(projectId: string, title: string, statements: string[]) {
  const { change: closed } = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
    withGovernedChange({ projectId, title, regionalTitle: `${title} (${statements.length} statements)` }, async () => {
      const db = await workspaceRawClient(projectId)
      for (const sql of statements) await db.$executeRawUnsafe(sql)
    }),
  )
  if (!closed) throw new Error(`${title} recorded no change`)
  return closed
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  // The ledger records nothing in integration mode, which runs no DDL.
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()

  await run(homeUrl(), `CREATE DATABASE "${REGIONAL_DB}"`)
  regionalDbCreated = true
  // The real table and grants, as the region's database procedure installs
  // them; backenly_app_role() names the role the application connects as.
  await run(regionalUrl, `CREATE FUNCTION public.backenly_app_role() RETURNS text LANGUAGE sql AS $$ SELECT current_user::text $$`)
  await run(regionalUrl, fs.readFileSync('scripts/sql/regional-bodies.sql', 'utf8'))
  process.env[REGION_VARIABLE] = regionalUrl

  ownerId = (
    await prisma.user.create({ data: { email: `ledger-residency-${randomUUID()}@example.test`, name: 'ledger residency fixture' }, select: { id: true } })
  ).id
  regionalProject = (
    await prisma.project.create({ data: { name: `ledger-region-${randomUUID()}`, userId: ownerId, region: 'us-east-1' }, select: { id: true } })
  ).id
  homeProject = (await prisma.project.create({ data: { name: `ledger-home-${randomUUID()}`, userId: ownerId }, select: { id: true } })).id

  for (const [projectId, url] of [[regionalProject, regionalUrl], [homeProject, homeUrl()]] as const) {
    await run(url, `CREATE SCHEMA "${schemaOf(projectId)}"`)
    await prisma.workspace.create({
      data: { name: 'ledger residency fixture', projectId, postgresSchema: schemaOf(projectId), databaseProvisioned: true },
    })
  }
})

afterAll(async () => {
  process.env.ENGINE_MODE = originalEngineMode
  // The change lock and the regional clients hold connections to the
  // regional database, which is dropped below.
  await closeChangeLockPool()
  await closeAllWorkspacePools()
  await disconnectRegionalClients().catch(() => {})
  await run(homeUrl(), `DROP SCHEMA IF EXISTS "${schemaOf(homeProject)}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
  delete process.env[REGION_VARIABLE]
  if (regionalDbCreated) await run(homeUrl(), `DROP DATABASE IF EXISTS "${REGIONAL_DB}" WITH (FORCE)`).catch(() => {})
})

describe('a change to a regional project', () => {
  const s = () => schemaOf(regionalProject)
  let created = ''
  let removed = ''
  let removedOnce = ''
  let before: Record<string, string | null> = {}

  it('keeps no definition on its home record, and names every object it made', async () => {
    const closed = await change(regionalProject, 'create the notes objects', createObjects(s(), MARK))
    expect(closed.status).toBe('healthy')
    created = closed.id

    expect(await homeCopies(regionalProject, MARK)).toEqual(NONE)

    const row = await prisma.backendChange.findUniqueOrThrow({ where: { id: created } })
    expect((row.checkpoint as any).definitionsInRegion).toBe(true)
    const after = row.resultState as any
    const notes = after.tables.notes
    // Structure is kept: names, types, flags, references.
    expect(notes.columns.map((c: any) => [c.name, c.type])).toEqual([
      ['id', 'integer'], ['owner', 'text'], ['note', 'text'], ['qty', 'integer'], ['shout', 'text'],
    ])
    expect(notes.constraints.map((c: any) => c.name).sort()).toEqual(['notes_pkey', 'notes_qty_check'])
    expect(notes.indexes.map((i: any) => i.name)).toEqual(['notes_partial'])
    expect(notes.policies.map((p: any) => p.name)).toEqual(['notes_policy'])
    expect(notes.triggers.map((t: any) => t.name)).toEqual(['notes_stamp'])
    expect(notes.rls).toEqual({ enabled: true, forced: false })
    expect(Object.keys(after.objects).sort()).toEqual(['mood', 'notes_view', 'stamp()'])
    // Each definition is a digest.
    const digests = [
      notes.columns.find((c: any) => c.name === 'note').default,
      notes.columns.find((c: any) => c.name === 'shout').generated,
      ...notes.constraints.map((c: any) => c.definition),
      notes.indexes[0].definition,
      notes.policies[0].using,
      notes.triggers[0].definition,
      notes.comment,
      ...Object.values(after.objects).map((o: any) => o.definition),
    ]
    for (const d of digests) expect(d).toMatch(/^kept-in-region:[0-9a-f]{32}$/)
    // The footprint names them and quotes none.
    const lines = (row.footprint as any[]).flatMap((c) => c.details)
    expect(lines).toEqual(expect.arrayContaining(['+ check notes_qty_check: (kept in its region)', '+ index notes_partial', '+ policy notes_policy (ALL)']))
    expect(row.summary).toMatch(/notes/)
  })

  it('is kept whole in the region, under the change', async () => {
    const body = await regionalBody(created)
    expect(body.projectId).toBe(regionalProject)
    expect(body.payload.key).toEqual(expect.any(String))
    // Trimmed as the record is: the whole catalog it opened with is gone.
    expect(body.payload.opened).toBeUndefined()
    const text = JSON.stringify(body.payload.resultState)
    for (const kind of ['DEFAULT', 'GENERATED', 'CHECK', 'INDEX', 'POLICY', 'FUNCTION', 'TRIGGER', 'COMMENT', 'VIEW']) {
      expect(text).toContain(`MARKER_${kind}_${MARK}`)
    }
    expect(text).toContain(`marker_enum_${MARK}`)
    // And nothing of it in the home database's own copy of the bodies table, if it had one.
    expect(await rowsIn(homeUrl(), `SELECT to_regclass('public.regional_bodies') AS t`)).toEqual([{ t: null }])
  })

  it('is restored from the region, every definition put back exactly, and the restore quotes none at home', async () => {
    before = await definitionsIn(regionalUrl, s())
    expect(Object.values(before).every((v) => v !== null)).toBe(true)

    const closed = await change(regionalProject, 'remove the notes objects', dropObjects(s()))
    expect(closed.status).toBe('healthy')
    removed = closed.id
    expect(await definitionsIn(regionalUrl, s())).toMatchObject({ view: null, function: null, check: null, index: null, trigger: null })

    const preview = await previewRecovery(regionalProject, removed)
    expect(preview).toMatchObject({ safety: 'lossless' })
    const out = await recoverChange(regionalProject, removed, { mode: 'manual', actorUserId: ownerId })
    expect(out).toMatchObject({ ok: true, status: 'restored' })

    expect(await definitionsIn(regionalUrl, s())).toEqual(before)
    expect(await homeCopies(regionalProject, MARK)).toEqual(NONE)
  })

  it('refuses a restore point whose regional copy was altered, and one the region no longer has', async () => {
    const closed = await change(regionalProject, 'remove the view', [`DROP VIEW "${s()}".notes_view`])
    removedOnce = closed.id

    await run(
      regionalUrl,
      `UPDATE public.regional_bodies
          SET "payload" = jsonb_set("payload", '{checkpoint,objects,notes_view,definition}', to_jsonb('SELECT 1 AS tampered'::text))
        WHERE "kind" = 'change_catalog' AND "id" = '${removedOnce}'`,
    )
    expect(await previewRecovery(regionalProject, removedOnce)).toMatchObject({ safety: 'unavailable', reason: expect.stringMatching(/integrity/) })
    expect(await recoverChange(regionalProject, removedOnce, { mode: 'manual', actorUserId: ownerId })).toMatchObject({ ok: false, code: 'INTEGRITY' })

    await run(regionalUrl, `DELETE FROM public.regional_bodies WHERE "kind" = 'change_catalog' AND "id" = '${removedOnce}'`)
    expect(await recoverChange(regionalProject, removedOnce, { mode: 'manual', actorUserId: ownerId })).toMatchObject({ ok: false, code: 'INTEGRITY' })

    // Nothing was restored from either.
    expect((await definitionsIn(regionalUrl, s())).view).toBeNull()
  })

  it('records a change the process never finished with names only, read from the region it opened with', async () => {
    const key = newCatalogKey()
    const opened = await withChangeLock(regionalProject, (client) => readCatalogOn(client, s()))
    const id = randomUUID()
    await keepCatalogInRegion(regionalProject, id, { key, opened })
    const last = await prisma.backendChange.findFirstOrThrow({ where: { projectId: regionalProject }, orderBy: { seq: 'desc' }, select: { seq: true } })
    await prisma.backendChange.create({
      data: {
        id,
        projectId: regionalProject,
        seq: last.seq + 1,
        source: 'system',
        title: 'interrupted',
        status: 'applying',
        checkpoint: { database: catalogStructure(opened, key), definitionsInRegion: true } as any,
      },
    })
    // What it did before the process stopped.
    await run(regionalUrl, `CREATE TABLE "${s()}".late (id int PRIMARY KEY, label text DEFAULT 'MARKER_LATE_${MARK}')`)

    expect(await reconcileChange(regionalProject, id, new Date(Date.now() + 24 * 60 * 60 * 1000))).toBe('manual_intervention_required')
    const row = await prisma.backendChange.findUniqueOrThrow({ where: { id } })
    expect((row.footprint as any[]).map((c) => c.after)).toEqual(['late'])
    expect((row.footprint as any[])[0].details).toEqual(expect.arrayContaining(['+ column label text DEFAULT (kept in its region)']))
    expect(await homeCopies(regionalProject, MARK)).toEqual(NONE)
  })
})

describe('a change to a home-region project', () => {
  it('keeps its definitions on its record, as before, and nothing in a region', async () => {
    const closed = await change(homeProject, 'create the notes objects', createObjects(schemaOf(homeProject), HOME_MARK))
    expect(closed.status).toBe('healthy')
    const copies = await homeCopies(homeProject, HOME_MARK)
    expect(copies.backend_changes).toBe(1)
    const row = await prisma.backendChange.findUniqueOrThrow({ where: { id: closed.id } })
    expect((row.checkpoint as any).definitionsInRegion).toBeUndefined()
    expect(JSON.stringify(row.resultState)).toContain(`MARKER_VIEW_${HOME_MARK}`)
    expect(await regionalBody(closed.id)).toBeUndefined()
  })
})
