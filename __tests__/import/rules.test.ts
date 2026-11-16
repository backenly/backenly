/**
 * THE SOURCE'S ACCESS RULES, TRANSLATED FOR APPROVAL (lib/import/rules.ts)
 * ======================================================================
 * Supabase RLS policies become ONE exact set_rls call per table, held for a
 * person to approve. The translation understands Supabase's own shapes and
 * refuses everything else rather than guessing, because a mistranslated
 * policy is a widened one.
 */

import { proposeForTable, proposeRules, translateExpression } from '@/lib/import/rules'
import type { CatalogPolicy, ImportPlan, PlannedTable } from '@/lib/import/pg-plan'

function planned(name: string, columnMap: Record<string, string> = { user_id: 'user_id', id: 'id' }): PlannedTable {
  return {
    sourceSchema: 'public',
    sourceName: name,
    sourceKey: `public.${name}`,
    name,
    columns: [],
    select: [],
    copy: [],
    pk: { kind: 'uuid', columns: ['id'], carrier: null },
    deferredForeignKeys: [],
    rows: 0,
    rowsExact: true,
    bytes: 0,
    notes: [],
    columnMap,
  }
}

function policy(name: string, command: string, using: string | null, check: string | null = null, extra: Partial<CatalogPolicy> = {}): CatalogPolicy {
  return { schema: 'public', table: 'posts', name, command, permissive: true, roles: ['public'], using, check, ...extra }
}

describe('expressions', () => {
  it("understands Supabase's spellings of the owner check", () => {
    for (const e of ['(auth.uid() = user_id)', '(user_id = auth.uid())', '(( SELECT auth.uid() AS uid) = user_id)', '((auth.uid())::text = (user_id)::text)']) {
      expect(translateExpression(e)).toEqual({ kind: 'owner', column: 'user_id' })
    }
  })

  it('true, and signed in', () => {
    expect(translateExpression('true')).toEqual({ kind: 'anyone' })
    expect(translateExpression("(auth.role() = 'authenticated'::text)")).toEqual({ kind: 'signed_in' })
    expect(translateExpression('(auth.uid() IS NOT NULL)')).toEqual({ kind: 'signed_in' })
  })

  it('refuses what it does not understand', () => {
    expect(translateExpression("(tenant_id = current_setting('app.tenant'))")).toBeNull()
    expect(translateExpression('(EXISTS ( SELECT 1 FROM members m WHERE m.user_id = auth.uid()))')).toBeNull()
    expect(translateExpression("((auth.jwt() ->> 'email') = email)")).toBeNull()
  })
})

describe('one table', () => {
  it('owner-only on every command becomes own_rows', () => {
    const p = proposeForTable(planned('posts'), [policy('own', 'ALL', '(auth.uid() = user_id)')])
    expect(p.action).toEqual({ template: 'own_rows', userIdColumn: 'user_id' })
    expect(p.summary).toMatch(/Read, add, change, delete: the row's owner \(user_id\)/)
  })

  it("anyone reads, owners write: each command as written, nothing widened", () => {
    const p = proposeForTable(planned('posts'), [
      policy('read', 'SELECT', 'true'),
      policy('insert', 'INSERT', null, '(auth.uid() = user_id)'),
      policy('update', 'UPDATE', '(auth.uid() = user_id)'),
    ])
    expect(p.action?.template).toBe('custom')
    expect(p.action?.commands).toEqual({
      select: { using: 'true' },
      insert: { check: `"user_id"::text = backenly_jwt_claim('sub')` },
      update: { using: `"user_id"::text = backenly_jwt_claim('sub')`, check: `"user_id"::text = backenly_jwt_claim('sub')` },
    })
    // DELETE had no policy in Supabase, so it stays server-key only.
    expect(p.action?.commands?.delete).toBeUndefined()
    expect(p.summary).toMatch(/Delete: the server key only/)
  })

  it('a policy granted to authenticated narrows true to signed-in users', () => {
    const p = proposeForTable(planned('posts'), [policy('read', 'SELECT', 'true', null, { roles: ['authenticated'] })])
    expect(p.action?.commands?.select).toEqual({ using: "backenly_jwt_claim('sub') IS NOT NULL" })
  })

  it('policies for the server key are ignored: it already reads everything', () => {
    const p = proposeForTable(planned('posts'), [policy('svc', 'ALL', 'true', null, { roles: ['service_role'] })])
    expect(p.action).toBeNull()
    expect(p.untranslated).toBeNull()
  })

  it('a restrictive policy, or an expression it cannot read, keeps the table closed and says so', () => {
    const r = proposeForTable(planned('posts'), [policy('own', 'ALL', '(auth.uid() = user_id)'), policy('tenant', 'ALL', 'true', null, { permissive: false })])
    expect(r.action).toBeNull()
    expect(r.untranslated).toMatch(/restrictive/)
    const u = proposeForTable(planned('posts'), [policy('team', 'SELECT', '(team_id IN ( SELECT ...))')])
    expect(u.action).toBeNull()
    expect(u.summary).toMatch(/answers only the server key/)
  })

  it('an owner column that did not arrive refuses rather than pointing at nothing', () => {
    const p = proposeForTable(planned('posts', { id: 'id' }), [policy('own', 'ALL', '(auth.uid() = owner)')])
    expect(p.action).toBeNull()
  })

  it('the definition quotes the source, policy by policy', () => {
    const p = proposeForTable(planned('posts'), [policy('own', 'ALL', '(auth.uid() = user_id)')])
    expect(p.definition).toBe('own: ALL TO public USING ((auth.uid() = user_id))')
  })
})

describe('every table', () => {
  const plan: ImportPlan = { tables: [planned('posts'), planned('notes'), planned('open_table')], names: {}, warnings: [] }

  it('a Supabase table with RLS off is not opened, and the warning says so', () => {
    const rls = new Map([['public.posts', true], ['public.notes', true], ['public.open_table', false]])
    const { proposals, warnings } = proposeRules(plan, [policy('own', 'ALL', '(auth.uid() = user_id)')], rls, 'supabase')
    expect(proposals.map((p) => p.table)).toEqual(['posts'])
    expect(warnings.join(' ')).toMatch(/Row-level security was off for open_table/)
  })
})
