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
  parseMigrationArgs,
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
