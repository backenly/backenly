/**
 * THE JOB'S PROGRESS AND THE REQUEST BODIES
 * ========================================
 * lib/import/progress.ts: drivers report patches; tables are keyed by name in
 * first-seen order, copied counts only go up, totals take the latest value,
 * warnings are kept once.
 *
 * lib/import/validation.ts: bodies are refused with `{ error, field }`, the
 * field named as the console's form names it.
 */

import { initialProgress, mergeProgress } from '@/lib/import/progress'
import { parseInspect, parseStart } from '@/lib/import/validation'

const ORG = '2f1d7c1e-8b8e-4b8a-9a55-2b0e3f1c4d5e'
const base = () =>
  initialProgress({ jobId: 'j', projectId: 'p', projectName: 'My app', region: 'ap-south-1', orgId: ORG, source: 'supabase', startedAt: new Date('2026-11-16T00:00:00Z'), phase: 'tables' })

describe('progress', () => {
  it('starts running, with nothing copied', () => {
    expect(base()).toMatchObject({ projectName: 'My app', region: 'ap-south-1', status: 'running', phase: 'tables', tables: [], users: null, files: null, rulesPending: 0, warnings: [], error: null, finishedAt: null })
  })

  it('keys tables by name, keeps their order, and never moves a bar back', () => {
    let p = base()
    p = mergeProgress(p, { tables: [{ name: 'a', sourceRows: 10, copiedRows: 0, verified: false }, { name: 'b', sourceRows: 5, copiedRows: 0, verified: false }] })
    p = mergeProgress(p, { tables: [{ name: 'b', sourceRows: 5, copiedRows: 5, verified: false }] })
    p = mergeProgress(p, { tables: [{ name: 'a', sourceRows: 10, copiedRows: 7, verified: false }] })
    p = mergeProgress(p, { tables: [{ name: 'a', sourceRows: 10, copiedRows: 3, verified: false }] }) // a late report
    expect(p.tables.map((t) => t.name)).toEqual(['a', 'b'])
    expect(p.tables[0].copiedRows).toBe(7)
    p = mergeProgress(p, { tables: [{ name: 'a', sourceRows: 10, copiedRows: 10, verified: true }] })
    expect(p.tables[0]).toEqual({ name: 'a', sourceRows: 10, copiedRows: 10, verified: true })
  })

  it('users and files: copied only goes up, totals are facts', () => {
    let p = base()
    p = mergeProgress(p, { users: { total: 100, copied: 50 } })
    p = mergeProgress(p, { users: { total: 98, copied: 20 } })
    expect(p.users).toEqual({ total: 98, copied: 50 })
    p = mergeProgress(p, { files: { total: 3, copied: 2, bytes: 300, copiedBytes: 200 } })
    p = mergeProgress(p, { files: { total: 3, copied: 1, bytes: 300, copiedBytes: 100 } })
    expect(p.files).toEqual({ total: 3, copied: 2, bytes: 300, copiedBytes: 200 })
  })

  it('warnings once each; phase, rules and error as given; inputs never mutated', () => {
    const start = base()
    let p = mergeProgress(start, { warnings: ['x', 'y'], phase: 'rows' })
    p = mergeProgress(p, { warnings: ['y', 'z'], rulesPending: 3, error: null })
    expect(p.warnings).toEqual(['x', 'y', 'z'])
    expect(p.phase).toBe('rows')
    expect(p.rulesPending).toBe(3)
    expect(start.warnings).toEqual([])
  })
})

describe('validation', () => {
  const supabase = { source: 'supabase', connectionString: 'postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres' }

  it('accepts the inspect body, with or without the top-level source', () => {
    expect(parseInspect({ orgId: ORG, connection: supabase })).toMatchObject({ ok: true })
    expect(parseInspect({ orgId: ORG, source: 'supabase', connection: supabase })).toMatchObject({ ok: true })
  })

  it('a source that disagrees with the connection is refused', () => {
    expect(parseInspect({ orgId: ORG, source: 'postgres', connection: supabase })).toMatchObject({ ok: false, error: expect.stringMatching(/do not match/) })
  })

  it('names the field a refusal belongs under', () => {
    expect(parseInspect({ orgId: ORG, connection: { source: 'supabase', connectionString: '' } })).toEqual({ ok: false, error: 'Paste the connection string.', field: 'connectionString' })
    expect(parseInspect({ orgId: ORG, connection: { source: 'firebase' } })).toMatchObject({ ok: false, field: 'serviceAccountJson' })
    expect(parseInspect({ orgId: ORG, connection: { source: 'postgres', connectionString: 'postgresql://u:p@h/d', schemas: ['bad name'] } })).toMatchObject({ ok: false, field: 'schemas' })
    expect(parseInspect({ orgId: 'nope', connection: supabase })).toMatchObject({ ok: false, error: 'Choose an organization.' })
    expect(parseInspect({ orgId: ORG, connection: { source: 'mysql' } })).toMatchObject({ ok: false, error: 'Choose Supabase, Firebase or Postgres.' })
  })

  it('the start body: name and region required, include defaults to everything', () => {
    const r = parseStart({ orgId: ORG, connection: supabase, name: '  My app  ', region: 'ap-south-1' })
    expect(r).toMatchObject({ ok: true, value: { name: 'My app', region: 'ap-south-1', include: { users: true, files: true } } })
    expect(parseStart({ orgId: ORG, connection: supabase, name: '', region: 'ap-south-1' })).toMatchObject({ ok: false, field: 'name' })
    expect(parseStart({ orgId: ORG, connection: supabase, name: 'x' })).toMatchObject({ ok: false, field: 'region' })
    expect(parseStart({ orgId: ORG, connection: supabase, name: 'x', region: 'r', include: { users: false, files: true } })).toMatchObject({ ok: true, value: { include: { users: false, files: true } } })
  })

  it('an empty Project URL or key counts as not given', () => {
    const r = parseInspect({ orgId: ORG, connection: { ...supabase, projectUrl: '  ', serviceRoleKey: '' } })
    expect(r.ok && r.value.connection).toEqual({ source: 'supabase', connectionString: supabase.connectionString })
  })
})
