/**
 * RECOVERY-ONLY POLICY RESTORE — narrow on purpose
 * ================================================
 *
 * The sibling of `recovery-drop-column.ts`, built for the same reason and under
 * the same constraints.
 *
 * `REMOVE_PERMISSION(table)` exists and removes ALL policies on a table. Routing
 * a policy rollback through it would be worse than having no rollback: undoing
 * "we replaced three fragmented policies with one" by removing every policy
 * leaves the table unprotected, which is a security regression dressed as a
 * recovery. `#80` recorded `restore_policies` as honestly `not_implemented`
 * rather than pretend that verb was an inverse.
 *
 * What makes an exact restore safe here is the same strictly-stronger
 * precondition the column primitive relies on:
 *
 *   - the table is named by the execution record, not by a caller
 *   - `observedPreState` holds the EXACT policy set that existed before
 *   - the stale guard has confirmed the live policies still match
 *     `observedPostState`, so nothing has replaced them since
 *   - the project's maintenance lock is held
 *
 * There is no parameter a user or an agent supplies. Exactly two callers exist,
 * and both are rollback paths bound to one execution:
 *
 *   - the maintenance rollback path, identity from the step ledger;
 *   - the autonomous auto-fix executor, for a `tighten_policy` repair the
 *     Authority Decision authorized on this recovery. It captures the pre-state
 *     before the repair and the post-state inside the same build lock, and
 *     calls this only when the verifier rejects the repair.
 *
 * ── Why capture is a policy DEFINITION, not a policy name ───────────────────
 *
 * Restoring by name would recreate a policy that permits something different.
 * `pg_policies` exposes the parts that define behaviour — command, permissive
 * or restrictive, the roles it binds, the USING expression and the WITH CHECK
 * expression — and all of them are captured, because a restore that changes any
 * one of them has not restored anything.
 */

import { executeWorkspace, queryWorkspace, resolveWorkspaceSchema } from '@/lib/services/workspace-pool'

/** These reach raw DDL. Both come from the ledger, and both are checked anyway. */
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/** One policy, in the detail needed to recreate it exactly. */
export interface CapturedPolicy {
  name: string
  /** PERMISSIVE or RESTRICTIVE. */
  permissive: string
  /** Roles the policy binds, as PostgreSQL reports them. */
  roles: string[]
  /** ALL | SELECT | INSERT | UPDATE | DELETE. */
  cmd: string
  /** The USING expression, or null when the policy has none. */
  qual: string | null
  /** The WITH CHECK expression, or null when the policy has none. */
  withCheck: string | null
}

export interface PolicyCapture {
  table: string
  policies: CapturedPolicy[]
  /** Whether RLS was enabled and forced, which policies alone do not say. */
  rlsEnabled: boolean
  rlsForced: boolean
  capturedAt: string
}

/**
 * Read the exact policy set for a table.
 *
 * Used for BOTH the pre-state (before the forward step) and the post-state
 * (immediately after it). The post-state is what the stale guard compares
 * against; without it, "restore the policies" could not tell the policies this
 * execution created from ones somebody wrote afterwards.
 */
export async function capturePolicies(
  projectId: string,
  table: string,
): Promise<PolicyCapture> {
  if (!IDENT.test(table)) throw new Error(`Refusing to capture policies for "${table}"`)
  const schema = await resolveWorkspaceSchema(projectId)

  const rows = await queryWorkspace<{
    policyname: string
    permissive: string
    roles: string[] | string
    cmd: string
    qual: string | null
    with_check: string | null
  }>(
    projectId,
    `SELECT policyname, permissive, roles, cmd, qual, with_check
       FROM pg_policies
      WHERE schemaname = $1 AND tablename = $2
      ORDER BY policyname`,
    [schema, table],
  )

  const rls = await queryWorkspace<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    projectId,
    `SELECT c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, table],
  )

  return {
    table,
    policies: (rows ?? []).map(r => ({
      name: r.policyname,
      permissive: r.permissive,
      roles: Array.isArray(r.roles)
        ? r.roles
        : String(r.roles ?? '')
            .replace(/^\{|\}$/g, '')
            .split(',')
            .filter(Boolean),
      cmd: r.cmd,
      qual: r.qual,
      withCheck: r.with_check,
    })),
    rlsEnabled: rls?.[0]?.relrowsecurity ?? false,
    rlsForced: rls?.[0]?.relforcerowsecurity ?? false,
    capturedAt: new Date().toISOString(),
  }
}

/**
 * Are two captures the same protection?
 *
 * Compared on behaviour, not on serialisation: policy ORDER is not meaningful,
 * so both sides are sorted, and a capture that differs only in `capturedAt` is
 * the same protection.
 */
export function samePolicies(a: PolicyCapture, b: PolicyCapture): boolean {
  if (a.rlsEnabled !== b.rlsEnabled || a.rlsForced !== b.rlsForced) return false
  const norm = (c: PolicyCapture) =>
    [...c.policies]
      .sort((x, y) => x.name.localeCompare(y.name))
      .map(p => `${p.name}|${p.permissive}|${[...p.roles].sort().join(',')}|${p.cmd}|${p.qual ?? ''}|${p.withCheck ?? ''}`)
      .join('\n')
  return norm(a) === norm(b)
}

export type RestoreOutcome =
  /** The live policies matched the pre-state afterwards, verified independently. */
  | { status: 'verified'; message: string }
  /** The inverse ran and the result does NOT match the pre-state. */
  | { status: 'failed'; message: string }
  /** The inverse ran and the verifier could not establish the result. */
  | { status: 'unverified'; message: string }
  /** The live policies no longer match the post-state, so this may not act. */
  | { status: 'blocked_stale'; message: string }

/**
 * Restore a table's policies to an exact captured pre-state.
 *
 * Refuses unless the live policy set still matches `observedPostState`. That is
 * the stale guard, and it is what stops this from overwriting somebody else's
 * later change: a table whose policies were rewritten after the forward step is
 * no longer the table this execution mutated.
 */
export async function recoveryRestorePolicies(
  projectId: string,
  observedPreState: PolicyCapture,
  observedPostState: PolicyCapture,
): Promise<RestoreOutcome> {
  const table = observedPreState.table
  if (!IDENT.test(table)) {
    return { status: 'failed', message: `Refusing to restore policies for "${table}"` }
  }
  const schema = await resolveWorkspaceSchema(projectId)

  // ── Stale guard, before anything is changed ──────────────────────────────
  let live: PolicyCapture
  try {
    live = await capturePolicies(projectId, table)
  } catch (err: any) {
    // Could not read the current state, so it cannot be established that this
    // is still the resource the execution left behind. Not a failure to undo;
    // a refusal to act blind.
    return {
      status: 'blocked_stale',
      message: `Could not read current policies for "${table}": ${err?.message ?? err}`,
    }
  }

  if (!samePolicies(live, observedPostState)) {
    return {
      status: 'blocked_stale',
      message:
        `Policies on "${table}" no longer match what this execution left behind. ` +
        'Something changed them since, so restoring the pre-state would overwrite ' +
        'that change rather than undo this one.',
    }
  }

  // ── The inverse ──────────────────────────────────────────────────────────
  try {
    for (const p of live.policies) {
      if (!IDENT.test(p.name)) {
        return { status: 'failed', message: `Refusing to drop policy "${p.name}"` }
      }
      await executeWorkspace(projectId, `DROP POLICY "${p.name}" ON "${schema}"."${table}"`, [])
    }

    for (const p of observedPreState.policies) {
      if (!IDENT.test(p.name)) {
        return { status: 'failed', message: `Refusing to recreate policy "${p.name}"` }
      }
      const parts = [`CREATE POLICY "${p.name}" ON "${schema}"."${table}"`]
      if (p.permissive?.toUpperCase() === 'RESTRICTIVE') parts.push('AS RESTRICTIVE')
      if (p.cmd && p.cmd.toUpperCase() !== 'ALL') parts.push(`FOR ${p.cmd.toUpperCase()}`)
      if (p.roles.length > 0 && !(p.roles.length === 1 && p.roles[0] === 'public')) {
        parts.push(`TO ${p.roles.map(r => `"${r}"`).join(', ')}`)
      }
      if (p.qual) parts.push(`USING (${p.qual})`)
      if (p.withCheck) parts.push(`WITH CHECK (${p.withCheck})`)
      await executeWorkspace(projectId, parts.join(' '), [])
    }

    // RLS flags travel with the policies: restoring the policy set while
    // leaving the table unprotected would restore the rules and not the
    // protection.
    if (observedPreState.rlsEnabled !== live.rlsEnabled) {
      await executeWorkspace(
        projectId,
        `ALTER TABLE "${schema}"."${table}" ${observedPreState.rlsEnabled ? 'ENABLE' : 'DISABLE'} ROW LEVEL SECURITY`,
        [],
      )
    }
    if (observedPreState.rlsForced !== live.rlsForced) {
      await executeWorkspace(
        projectId,
        `ALTER TABLE "${schema}"."${table}" ${observedPreState.rlsForced ? 'FORCE' : 'NO FORCE'} ROW LEVEL SECURITY`,
        [],
      )
    }
  } catch (err: any) {
    return {
      status: 'failed',
      message: `Restoring policies on "${table}" failed: ${err?.message ?? err}`,
    }
  }

  // ── Independent verification ─────────────────────────────────────────────
  //
  // The inverse returning without throwing is not proof of restoration. Only a
  // fresh read establishes that, and a verifier that cannot complete reports
  // `unverified` rather than assuming either answer (#79).
  let after: PolicyCapture
  try {
    after = await capturePolicies(projectId, table)
  } catch (err: any) {
    return {
      status: 'unverified',
      message:
        `Policies on "${table}" were rewritten, but the result could not be read ` +
        `back: ${err?.message ?? err}`,
    }
  }

  if (!samePolicies(after, observedPreState)) {
    return {
      status: 'failed',
      message: `Policies on "${table}" were rewritten but do not match the pre-state.`,
    }
  }

  return {
    status: 'verified',
    message: `Policies on "${table}" restored to their exact pre-mutation state and verified.`,
  }
}
