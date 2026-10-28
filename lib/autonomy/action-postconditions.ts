/**
 * ACTION POSTCONDITIONS — did the change do what it said, read from the catalog
 * ===========================================================================
 * An AI-proposed repair is "fixed" only when three independent checks agree:
 * this postcondition, the owning probe's re-check (recheckGap), and the
 * regression check. This is the first of them, and it answers a narrower
 * question than the probe: not "is the finding gone", but "is the thing this
 * action was supposed to create now in the live catalog, exactly as asked".
 *
 * Three-valued, never a guess:
 *   confirmed   the catalog shows the intended state
 *   refuted     the catalog was read and the intended state is not there
 *   error       the catalog could not be read (the verifier threw)
 *
 * A verifier never catches its own read errors; `verifyPostcondition` turns a
 * throw into `error`, so a failed read can never be mistaken for either answer.
 *
 * Only actions listed here can be proposed (lib/autonomy/ai-proposals.ts).
 * Changing a verifier's meaning bumps POSTCONDITION_REGISTRY_VERSION, which is
 * part of every proposal's version, so approvals given against the old meaning
 * go stale instead of running under the new one.
 */

import { workspaceRawClient, type WorkspaceRawClient } from '@/lib/data-plane/regional'
import { resolveWorkspaceSchema } from '@/lib/services/workspace-pool'
import { typeFamily } from './intent-conformance'

export const POSTCONDITION_REGISTRY_VERSION = 'v1'

export type Postcondition = 'confirmed' | 'refuted' | 'error'

type Verifier = (
  db: WorkspaceRawClient,
  projectId: string,
  params: Record<string, unknown>,
) => Promise<'confirmed' | 'refuted'>

const VERIFIERS: Record<string, Verifier> = {
  /** The column exists on the table, in the requested type family. */
  ADD_COLUMN: async (db, projectId, params) => {
    const schema = await resolveWorkspaceSchema(projectId)
    const rows = await db.$queryRawUnsafe<Array<{ data_type: string }>>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
      schema,
      String(params.tableName),
      String(params.columnName),
    )
    if (rows.length === 0) return 'refuted'
    return typeFamily(rows[0].data_type) === typeFamily(String(params.columnType)) ? 'confirmed' : 'refuted'
  },
}

export function hasPostcondition(action: string): boolean {
  return action in VERIFIERS
}

export async function verifyPostcondition(
  action: string,
  projectId: string,
  params: Record<string, unknown>,
): Promise<Postcondition> {
  const verify = VERIFIERS[action]
  if (!verify) return 'error'
  // The database in the project's region, resolved outside the catch below: a
  // region this process cannot reach is not a verdict on the action.
  const db = await workspaceRawClient(projectId)
  try {
    return await verify(db, projectId, params)
  } catch {
    return 'error'
  }
}
