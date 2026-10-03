/**
 * The RLS positive control: objects created in a SCRATCH database so the RLS
 * reads can be shown to see a policy that exists.
 *
 * Deliberately not in capture.ts. The capture module is shared with the
 * production path, which is audited for mutation primitives before it is allowed
 * to ship, and this file is the one piece of that neighbourhood that contains
 * DDL. Keeping it separate means the production bundle cannot reach this text
 * even by accident, and the audit never has to be loosened to accommodate it.
 */

import type { RlsVisibility, Snapshot } from './capture'

export const RLS_CONTROL_SQL = `
CREATE TABLE public.lineage_rls_control (id integer PRIMARY KEY);
ALTER TABLE public.lineage_rls_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lineage_rls_control FORCE ROW LEVEL SECURITY;
CREATE POLICY lineage_rls_control_select ON public.lineage_rls_control FOR SELECT TO PUBLIC USING (id > 0);
CREATE TABLE public.lineage_rls_control_no_policy (id integer PRIMARY KEY);
ALTER TABLE public.lineage_rls_control_no_policy ENABLE ROW LEVEL SECURITY;
`

export function checkRlsControl(vis: RlsVisibility, snap: Snapshot): { pass: boolean; failures: string[] } {
  const failures: string[] = []
  const pub = vis.bySchema.find(s => s.schema === 'public')
  const expect = (label: string, actual: unknown, wanted: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      failures.push(`${label}: saw ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`)
    }
  }
  expect('visibility consistent', vis.consistent, true)
  expect('public tables', pub?.tables, 2)
  expect('public rls enabled', pub?.rlsEnabled, 2)
  expect('public rls forced', pub?.rlsForced, 1)
  expect('public rls enabled without policy', pub?.rlsEnabledWithoutPolicy, 1)
  expect('public policies via pg_policy', pub?.policiesFromCatalog, 1)
  expect('public policies via pg_policies', pub?.policiesFromView, 1)
  expect('public classification', pub?.classification, 'rls_with_policies')

  const policy = snap.policies.find(p => p.name === 'lineage_rls_control_select')
  expect('captured policy command', policy?.command, 'r')
  expect('captured policy roles', policy?.roles, ['public'])
  expect('captured policy using', policy?.using_expr, '(id > 0)')
  expect('captured policy permissive', policy?.permissive, true)
  const table = snap.tables.find(t => t.name === 'lineage_rls_control')
  expect('captured table rls', [table?.rls, table?.force_rls], [true, true])

  return { pass: failures.length === 0, failures }
}
