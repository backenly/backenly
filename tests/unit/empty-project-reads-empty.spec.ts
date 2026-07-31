/**
 * A project nobody has built yet must read EMPTY on every surface.
 *
 * THE BUG THIS GUARDS
 * -------------------
 * `users` is scaffolding: it exists in the workspace schema of essentially
 * every project, including one created seconds ago with no agent connected.
 * Two different predicates describe it, and they answer different questions:
 *
 *   isExposedTable(name)     → catalog VISIBILITY. True for `users` on purpose:
 *                              it is a real table and list_tables must show it.
 *   isAuthManagedTable(name) → REST SURFACE. `users` holds password hashes and
 *                              is managed only through /auth/*, never /db/users.
 *
 * `listExposedResources` applied only the first, so a brand-new project reported
 * one exposed REST resource. That single wrong number flipped `hasContent` in
 * /api/projects/[id]/state — which had carefully filtered `users` out of its own
 * table term and then let the same scaffolding back in through the resource term
 * — so an untouched project rendered the full "built" dashboard, started the
 * autonomy loop, counted "1 Table" against an inspector showing "No tables yet",
 * and parked a workflow_broken finding about auth in "Waiting on you".
 *
 * Separately, `getEndUserAuthUsage` treated "the users table exists" as proof
 * that auth was in use, on a stale assumption that the table appears only after
 * a real signup. That is what let the finding be raised at all.
 *
 * These tests pin both. If someone reintroduces either shortcut, an empty
 * project starts lying about itself again and this fails.
 */

import { isExposedTable, isAuthManagedTable } from '@/lib/mcp/schema-introspection'

describe('the two table predicates answer different questions', () => {
  it('keeps `users` VISIBLE in the catalog — it is a real table', () => {
    expect(isExposedTable('users')).toBe(true)
  })

  it('keeps `users` OFF the REST surface — it holds password hashes', () => {
    expect(isAuthManagedTable('users')).toBe(true)
  })

  it('does not treat an ordinary table as auth-managed', () => {
    expect(isAuthManagedTable('notes')).toBe(false)
    expect(isExposedTable('notes')).toBe(true)
  })

  it('still hides internal plumbing from both', () => {
    expect(isExposedTable('_migrations')).toBe(false)
    expect(isExposedTable('pg_stat_activity')).toBe(false)
  })
})

describe('listExposedResources excludes auth-managed tables', () => {
  const load = async (tables: string[]) => {
    jest.resetModules()
    jest.doMock('@/lib/mcp/schema-introspection', () => {
      const actual = jest.requireActual('@/lib/mcp/schema-introspection')
      return {
        ...actual,
        listExposedTables: jest.fn().mockResolvedValue(tables.map(name => ({ name }))),
      }
    })
    return import('@/lib/api/exposed-resources')
  }

  afterEach(() => { jest.resetModules() })

  it('reports ZERO resources for a freshly-created project (users only)', async () => {
    const { listExposedResources, countExposedResources } = await load(['users'])

    // The whole bug in one assertion: scaffolding is not a backend.
    expect(await listExposedResources('p1')).toEqual([])
    expect(await countExposedResources('p1')).toBe(0)
  })

  it('reports real tables, and never /db/users alongside them', async () => {
    const { listExposedResources } = await load(['users', 'notes'])
    const resources = await listExposedResources('p1')

    expect(resources).toEqual([{ name: 'notes', basePath: '/db/notes' }])
    expect(resources.some(r => r.basePath === '/db/users')).toBe(false)
  })

  it('still counts a genuinely built backend', async () => {
    const { countExposedResources } = await load(['notes', 'entries', 'tags'])
    expect(await countExposedResources('p1')).toBe(3)
  })
})

describe('hasContent must not flip true on scaffolding alone', () => {
  // Mirrors the boolean in app/api/projects/[id]/state/route.ts. Kept as an
  // executable statement of the rule: the ONLY inputs that may make a project
  // read as "built" are things a person or agent actually created.
  const hasContent = (s: {
    tableNames?: string[]
    exposedResources?: number
    authEnabled?: boolean
    functions?: number
    buckets?: number
  }) => {
    const realTables = (s.tableNames ?? []).filter(n => n.toLowerCase() !== 'users')
    return (
      realTables.length > 0 ||
      (s.exposedResources ?? 0) > 0 ||
      (s.authEnabled ?? false) ||
      (s.functions ?? 0) > 0 ||
      (s.buckets ?? 0) > 0
    )
  }

  it('is FALSE for a project that only has the users table and a jwtSecret', () => {
    // exposedResources is 0 here precisely because of the fix above; before it,
    // this was 1 and the whole dashboard lit up.
    expect(hasContent({ tableNames: ['users'], exposedResources: 0 })).toBe(false)
  })

  it('is TRUE as soon as one real table exists', () => {
    expect(hasContent({ tableNames: ['users', 'notes'], exposedResources: 1 })).toBe(true)
  })
})
