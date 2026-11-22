/**
 * Moving a project into a database of its own: the rules that decide rather
 * than do (lib/data-plane/tenancy-migration-rules.ts), and the names a move
 * leaves its old schemas under (lib/security/workspace-schema.ts). The move
 * itself runs against real PostgreSQL in
 * tests/integration/tenancy-migration.spec.ts.
 */

import { randomUUID } from 'crypto'

import {
  LONGEST_REQUEST_MS,
  UsageError,
  catalogDifferences,
  defaultWaits,
  describeOutcome,
  dropPoliciesSql,
  parseMigrationArgs,
  postgrestProbeTable,
  privilegeDifferences,
  privilegeStatements,
  splitRestoreList,
} from '@/lib/data-plane/tenancy-migration-rules'
import type { CatalogSnapshot, TableState } from '@/lib/changes/catalog'
import {
  isChangeVaultSchema,
  isMovedSchema,
  isProjectOwnedSchema,
  movedSchemaName,
} from '@/lib/security/workspace-schema'
import { MIGRATING_PAUSE_REASON, pausedDetails, pausedMessage, PAUSED_MESSAGE } from '@/lib/projects/serving-state'

const REGIONS = ['ap-south-1', 'us-east-1']

describe('the one line a move ends with', () => {
  it('says moved, dry-run ok, refused with its reason, or aborted with its step and reason', () => {
    expect(describeOutcome({ outcome: 'moved', attention: [] })).toBe('moved')
    expect(describeOutcome({ outcome: 'dry_run_ok', attention: [] })).toBe('dry-run ok')
    expect(describeOutcome({ outcome: 'refused', code: 'already_dedicated', reason: 'the project already has a database of its own', attention: [] })).toBe(
      'refused already_dedicated: the project already has a database of its own',
    )
    expect(describeOutcome({ outcome: 'aborted', step: 'verify', reason: 'rows: notes:\n 3 rows, 2 there', attention: [] })).toBe(
      'aborted verify: rows: notes: 3 rows, 2 there',
    )
  })

  it('says what needs a person after a move', () => {
    expect(describeOutcome({ outcome: 'moved', attention: ['smoke data_api: answered 503'] })).toBe('moved, needs attention: smoke data_api: answered 503')
  })
})

describe('the waits', () => {
  const bounds = { freshMs: 15_000, staleServingGraceMs: 60_000, dropAfterMs: 120_000, placementMaxAgeMs: 75_000 }

  it('outlast every cached serving answer and every request already running before the copy', () => {
    expect(defaultWaits(bounds).freezeMs).toBe(15_000 + 60_000 + LONGEST_REQUEST_MS)
  })

  it('keep the old schemas until PostgREST has stopped reading them and no process still resolves the project to them', () => {
    expect(defaultWaits(bounds).flipMs).toBe(120_000)
    expect(defaultWaits({ ...bounds, dropAfterMs: 10_000 }).flipMs).toBe(75_000 + 15_000)
  })
})

function table(name: string, over: Partial<TableState> = {}): TableState {
  return {
    name,
    oid: 1,
    columns: [{ name: 'id', attnum: 1, type: 'integer', notNull: true, default: null, identity: '', generated: null }],
    constraints: [],
    indexes: [],
    rls: { enabled: true, forced: true },
    policies: [],
    triggers: [],
    grants: [],
    comment: null,
    ...over,
  }
}

function catalog(tables: TableState[], objects: CatalogSnapshot['objects'] = {}): CatalogSnapshot {
  return { schema: 'workspace_x', capturedAt: '', tables: Object.fromEntries(tables.map((t) => [t.name, t])), objects }
}

describe('two catalogs of a moved schema', () => {
  it('are the same when only what a move cannot keep differs: oids, grants, column order', () => {
    const before = catalog([table('notes', { oid: 10, grants: [{ grantee: 'bkn_ro_aaaaaaaaaaaa', privilege: 'SELECT' }] })])
    const after = catalog([table('notes', { oid: 99, grants: [] })])
    expect(catalogDifferences(before, after)).toEqual([])
  })

  it('name each table missing, extra or different, and each object', () => {
    const fn = { kind: 'function' as const, name: 'f', identity: 'f()', definition: 'CREATE FUNCTION f() ...', options: [] }
    const before = catalog([table('notes'), table('gone')], { 'f()': fn })
    const after = catalog([table('notes', { rls: { enabled: true, forced: false } }), table('extra')], {})
    expect(catalogDifferences(before, after)).toEqual([
      'table gone is missing',
      'table notes differs',
      'table extra is extra',
      'function f() is missing',
    ])
  })
})

describe("the operator's arguments", () => {
  const id = randomUUID()

  it('move one project, or every one of a region a batch at a time, dry or not', () => {
    expect(parseMigrationArgs(['--region', 'us-east-1', '--project', id], REGIONS)).toEqual({
      mode: 'migrate',
      region: 'us-east-1',
      projects: [id],
      batch: 1,
      dryRun: false,
    })
    expect(parseMigrationArgs(['--region', 'us-east-1', '--all', '--batch', '5', '--dry-run'], REGIONS)).toEqual({
      mode: 'migrate',
      region: 'us-east-1',
      projects: 'all',
      batch: 5,
      dryRun: true,
    })
  })

  it('report, or close the shared database to PUBLIC with the roles it should still let in', () => {
    expect(parseMigrationArgs(['--region', 'ap-south-1', '--report'], REGIONS)).toEqual({ mode: 'report', region: 'ap-south-1' })
    expect(parseMigrationArgs(['--region', 'us-east-1', '--revoke-public-connect', '--grant-connect', 'monitor,ops_reader'], REGIONS)).toEqual({
      mode: 'revoke_public_connect',
      region: 'us-east-1',
      extraRoles: ['monitor', 'ops_reader'],
    })
  })

  it.each([
    [[] as string[], /--region is required/],
    [['--region', 'mars-1', '--all'], /Unknown region/],
    [['--region', 'us-east-1'], /exactly one of/],
    [['--region', 'us-east-1', '--all', '--project', id], /exactly one of/],
    [['--region', 'us-east-1', '--project', 'not-a-uuid'], /Not a project id/],
    [['--region', 'us-east-1', '--all', '--batch', '0'], /--batch is a whole number/],
    [['--region', 'us-east-1', '--all', '--batch', '21'], /--batch is a whole number/],
    [['--region', 'us-east-1', '--report', '--dry-run'], /--report takes only --region/],
    [['--region', 'us-east-1', '--revoke-public-connect', '--grant-connect', 'Robert"); --'], /Not a role name/],
    [['--region', 'us-east-1', '--all', '--grant-connect', 'monitor'], /goes with --revoke-public-connect/],
    [['--region', 'us-east-1', '--all', '--force'], /Unknown argument/],
    [['--region'], /needs a value/],
  ])('refuse %j', (argv, expected) => {
    expect(() => parseMigrationArgs(argv, REGIONS)).toThrow(UsageError)
    expect(() => parseMigrationArgs(argv, REGIONS)).toThrow(expected)
  })
})

describe('the names a move leaves its old schemas under', () => {
  const id = randomUUID()

  it('are the project’s own, so deleting it still finds them, and fit an identifier', () => {
    const canonical = movedSchemaName(id, 3)
    const branch = movedSchemaName(id, 3, 2)
    expect(canonical).toBe(`workspace_${id}_moved3`)
    expect(branch).toBe(`workspace_${id}_moved3_2`)
    for (const name of [canonical, branch, movedSchemaName(id, 9_999, 999)]) {
      expect(isProjectOwnedSchema(id, name)).toBe(true)
      expect(isMovedSchema(name)).toBe(true)
      expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63)
    }
    // Refused rather than cut short by PostgreSQL, where two could collide.
    expect(() => movedSchemaName(id, 2_000_000_000, 99)).toThrow(/longer than a PostgreSQL identifier/)
  })

  it('are no branch, no vault and nothing else of the project', () => {
    expect(isMovedSchema(`workspace_${id}`)).toBe(false)
    expect(isMovedSchema(`workspace_${id}_br_preview`)).toBe(false)
    expect(isMovedSchema(`workspace_${id}_r12`)).toBe(false)
    expect(isMovedSchema(`workspace_${id}_moved`)).toBe(false)
    expect(isMovedSchema(`workspace_${id}_moved1_x`)).toBe(false)
    expect(isChangeVaultSchema(movedSchemaName(id, 1, 1))).toBe(false)
  })

  it('need an epoch the move gave, and an id that is a project’s', () => {
    expect(() => movedSchemaName(id, 0)).toThrow()
    expect(() => movedSchemaName(id, 1.5)).toThrow()
    expect(() => movedSchemaName(id, 1, -1)).toThrow()
    expect(() => movedSchemaName('x"; DROP', 1)).toThrow()
  })
})

describe('the doors, while a project moves', () => {
  it('say it is being moved and serves again by itself, not that its owner must resume it', () => {
    expect(pausedMessage(MIGRATING_PAUSE_REASON)).toMatch(/being moved to a database of its own/)
    expect(pausedMessage(MIGRATING_PAUSE_REASON)).not.toBe(PAUSED_MESSAGE)
    const details = pausedDetails(randomUUID(), { pausedAt: new Date(), reason: MIGRATING_PAUSE_REASON })
    expect(details.hint).toMatch(/serves again by itself/)
    expect(pausedMessage('inactive')).toBe(PAUSED_MESSAGE)
  })
})

describe('the replay restores the policies last', () => {
  // pg_restore --list of a moved project's dump, as PostgreSQL 16 prints it: a table under row level security with
  // the data plane's soft-delete policy and a comment on a policy, beside the entries that must stay in order.
  const list = [
    ';',
    '; Archive created at 2026-11-22 11:49:21 UTC',
    ';',
    '; Selected TOC Entries:',
    ';',
    '6; 2615 16390 SCHEMA - workspace_0b1c backenly_backup',
    '220; 1259 16402 TABLE workspace_0b1c authors backenly_backup',
    '221; 1259 16408 TABLE workspace_0b1c secrets backenly_backup',
    '3401; 0 16402 TABLE DATA workspace_0b1c authors backenly_backup',
    '3250; 2606 16407 CONSTRAINT workspace_0b1c authors authors_pkey backenly_backup',
    '3402; 0 0 ROW SECURITY workspace_0b1c authors backenly_backup',
    '3403; 3256 16409 POLICY workspace_0b1c authors bkn_pgrst_soft_delete backenly_backup',
    '3404; 3256 16410 POLICY workspace_0b1c secrets "Owners only" backenly_backup',
    '3405; 0 0 COMMENT workspace_0b1c POLICY "Owners only" ON secrets backenly_backup',
    '3406; 0 0 COMMENT workspace_0b1c TABLE authors backenly_backup',
    '',
  ].join('\n')

  it('keeps every entry but the policies, in order, and puts the policies and the comments on them in the second half', () => {
    const { rest, policies } = splitRestoreList(list)
    const entries = (text: string) => text.split('\n').filter((l) => /^\d+;/.test(l)).map((l) => l.split(';')[0])
    expect(entries(rest)).toEqual(['6', '220', '221', '3401', '3250', '3402', '3406'])
    expect(entries(policies)).toEqual(['3403', '3404', '3405'])
    // The comment lines go to both, so each half is a list pg_restore reads as given.
    expect(rest.startsWith(';\n; Archive created')).toBe(true)
    expect(policies.startsWith(';\n; Archive created')).toBe(true)
    // Nothing is lost or repeated.
    expect([...entries(rest), ...entries(policies)].sort()).toEqual(entries(list).sort())
  })

  it('drops only the policies of the moved schemas, by their names', () => {
    const sql = dropPoliciesSql(['workspace_0b1c', 'workspace_0b1c_br_preview'])
    expect(sql).toContain("WHERE schemaname = ANY (ARRAY['workspace_0b1c', 'workspace_0b1c_br_preview']::text[])")
    expect(sql).toContain("pg_catalog.format('DROP POLICY %I ON %I.%I', p.policyname, p.schemaname, p.tablename)")
    expect(sql).toMatch(/^\n-- Backenly:/)
    expect(sql.trimEnd().endsWith('$backenly_replay$;')).toBe(true)
    expect(dropPoliciesSql(["it's"])).toContain("ARRAY['it''s']")
    expect(() => dropPoliciesSql([])).toThrow()
  })
})

describe("the verification's read through the project's own PostgREST", () => {
  it('skips the tables Backenly closes to the service role, and any it cannot read at the source', () => {
    // A project with end users and no other table: its only table is users, closed on purpose in both databases.
    expect(postgrestProbeTable(['_backenly_webhook_outbox', 'users'], new Set(['_backenly_webhook_outbox']))).toBeNull()
    expect(postgrestProbeTable(['users'], new Set())).toBeNull()
    // The first the service role reads at the source, in the order given.
    expect(postgrestProbeTable(['_meta', 'accounts', 'notes', 'users'], new Set(['notes', 'accounts']))).toBe('accounts')
    expect(postgrestProbeTable(['accounts', 'notes', 'users'], new Set(['notes']))).toBe('notes')
    // A name PostgREST would need quoted is not used.
    expect(postgrestProbeTable(['My Table', 'notes'], new Set(['My Table', 'notes']))).toBe('notes')
    expect(postgrestProbeTable([], new Set())).toBeNull()
  })
})

describe("PUBLIC's and the API roles' privileges, carried exactly", () => {
  const notes = { kind: 'table' as const, identity: 'workspace_0b1c.notes', grants: ['anon SELECT', 'authenticated SELECT', 'service_role DELETE', 'service_role INSERT', 'service_role SELECT', 'service_role UPDATE'] }
  const widened = { ...notes, grants: [...notes.grants, 'authenticated DELETE', 'authenticated INSERT', 'authenticated UPDATE'].sort() }
  const fn = { kind: 'routine' as const, identity: 'workspace_0b1c.closed_fn()', grants: [] as string[] }

  it('names what the copy lacks and what it holds that the source did not, and leaves one-sided objects to the catalog check', () => {
    const source = new Map([['table workspace_0b1c.notes', notes], ['routine workspace_0b1c.closed_fn()', fn]])
    const target = new Map([
      ['table workspace_0b1c.notes', widened],
      ['routine workspace_0b1c.closed_fn()', { ...fn, grants: ['PUBLIC EXECUTE'] }],
      ['table workspace_0b1c.only_here', { kind: 'table' as const, identity: 'workspace_0b1c.only_here', grants: [] }],
    ])
    expect(privilegeDifferences(source, target)).toEqual([
      'routine workspace_0b1c.closed_fn(): has PUBLIC EXECUTE it did not',
      'table workspace_0b1c.notes: has authenticated DELETE, authenticated INSERT, authenticated UPDATE it did not',
    ])
    expect(privilegeDifferences(source, source)).toEqual([])
  })

  it('makes the copy hold exactly the source privileges: everything taken from the carried grantees, then given back', () => {
    expect(privilegeStatements(notes)).toEqual([
      'REVOKE ALL ON TABLE workspace_0b1c.notes FROM PUBLIC, anon, authenticated, service_role',
      'GRANT SELECT ON TABLE workspace_0b1c.notes TO anon',
      'GRANT SELECT ON TABLE workspace_0b1c.notes TO authenticated',
      'GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE workspace_0b1c.notes TO service_role',
    ])
    expect(privilegeStatements(fn)).toEqual(['REVOKE ALL ON ROUTINE workspace_0b1c.closed_fn() FROM PUBLIC, anon, authenticated, service_role'])
    expect(privilegeStatements({ kind: 'sequence', identity: 'workspace_0b1c.notes_id_seq', grants: ['service_role USAGE'] })).toEqual([
      'REVOKE ALL ON SEQUENCE workspace_0b1c.notes_id_seq FROM PUBLIC, anon, authenticated, service_role',
      'GRANT USAGE ON SEQUENCE workspace_0b1c.notes_id_seq TO service_role',
    ])
    // Only the carried grantees and plain privilege names are ever written into a statement.
    expect(() => privilegeStatements({ ...notes, grants: ['postgres SELECT'] })).toThrow()
    expect(() => privilegeStatements({ ...notes, grants: ['anon SELECT; DROP TABLE x'] })).toThrow()
  })
})
