/**
 * A PAUSED OR DELETED PROJECT'S DIRECT POSTGRES LOGINS DO NOT CONNECT
 * ===================================================================
 *
 * Every door to a paused project answers PROJECT_PAUSED (lib/projects/serving-state.ts):
 * its API, MCP, functions and realtime. Its direct Postgres logins (bkn_ro_,
 * bkn_rw_, lib/services/direct-access.ts) go to the database itself, past all
 * of them, so pausing a project, or asking for it to be deleted, which pauses
 * it, stops them too: each is made NOLOGIN with no password and its sessions
 * are ended, through the definer helper (scripts/setup-direct-access.sql,
 * backenly_direct_retire_role). Its credential row is kept.
 *
 * Resuming, or restoring a deleted project that is not otherwise paused, brings
 * each back with its stored password, re-keyed through
 * backenly_direct_create_role. For a login that exists, that helper only sets
 * LOGIN and the password and re-applies the login's own settings (statement
 * timeout, idle-in-transaction timeout, search_path, and read-only for a
 * read-only login); it grants nothing. A password rotated while paused is the
 * stored one, so resuming uses it: backenly_direct_set_password sets the
 * password and never LOGIN, so a rotation leaves the login stopped.
 *
 * While a project is paused no login is created or re-keyed
 * (lib/services/direct-access.ts, DirectAccessPausedError).
 *
 * Nothing here throws. A failure is logged, and the hourly pass
 * (reconcileDirectLoginsWithPause, instrumentation.ts) brings every project's
 * logins in line with whether it is paused, as the next pause or resume does.
 */

import { prisma } from '@/lib/db/prisma'
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { decryptValue } from '@/lib/security/projectEnvCrypto'
import { resolveWorkspaceSchema } from '@/lib/services/workspace-pool'

type RawClient = Awaited<ReturnType<typeof workspaceRawClient>>

const helperMissingSaid = new Set<string>()

function failure(err: unknown): string {
  return err instanceof Error ? err.name : 'Error'
}

/** Each login's rolcanlogin, by name; a name with no role is absent. */
async function loginState(db: RawClient, roles: string[]): Promise<Map<string, boolean>> {
  const rows = await db.$queryRaw<Array<{ rolname: string; rolcanlogin: boolean }>>`
    SELECT rolname::text AS rolname, rolcanlogin FROM pg_roles WHERE rolname = ANY(${roles}::text[])`
  return new Map(rows.map((r) => [r.rolname, r.rolcanlogin]))
}

/** Whether this database has the helper; said once per helper when it does not. */
async function hasHelper(db: RawClient, signature: string): Promise<boolean> {
  const [probe] = await db.$queryRaw<Array<{ present: boolean }>>`SELECT to_regprocedure(${signature}) IS NOT NULL AS present`
  if (probe?.present) return true
  if (!helperMissingSaid.has(signature)) {
    helperMissingSaid.add(signature)
    console.warn(`[DirectAccess] ${signature} is not installed here, so paused projects' logins are not stopped or brought back until scripts/setup-direct-access.sql is installed again`)
  }
  return false
}

/**
 * Stop the project's direct logins: NOLOGIN, no password, sessions ended. Only
 * those that can still log in are touched. Answers the logins stopped. Never
 * throws.
 */
export async function stopDirectLogins(projectId: string, why: string): Promise<string[]> {
  try {
    const rows = await prisma.databaseCredential.findMany({ where: { projectId }, select: { roleName: true } })
    if (rows.length === 0) return []
    const db = await workspaceRawClient(projectId)
    if (!(await hasHelper(db, 'public.backenly_direct_retire_role(text)'))) return []
    const state = await loginState(db, rows.map((r) => r.roleName))
    const stopped = rows.map((r) => r.roleName).filter((role) => state.get(role) === true)
    for (const role of stopped) await db.$queryRaw`SELECT public.backenly_direct_retire_role(${role}) AS retired`
    // A session that logged in while the first call ran outlived it: the
    // helper ends the login's sessions again, now that NOLOGIN has committed.
    for (const role of stopped) await db.$queryRaw`SELECT public.backenly_direct_retire_role(${role}) AS retired`
    if (stopped.length > 0) console.log(`[DirectAccess] project=${projectId}: ${stopped.length} login(s) stopped (${why})`)
    return stopped
  } catch (err) {
    console.warn(`[DirectAccess] project=${projectId}: logins not stopped (${why}): ${failure(err)}; the hourly pass tries again`)
    return []
  }
}

/**
 * Bring the project's direct logins back with their stored passwords, if the
 * project is not paused: those that exist and cannot log in. Answers the
 * logins brought back. Never throws.
 */
export async function restoreDirectLogins(projectId: string, why: string): Promise<string[]> {
  try {
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { pausedAt: true } })
    // Still paused (for inactivity, say, after a deleted project's restore): they stay stopped.
    if (!project || project.pausedAt) return []
    const rows = await prisma.databaseCredential.findMany({
      where: { projectId },
      select: { roleName: true, mode: true, passwordCipher: true, passwordIv: true, passwordTag: true },
    })
    if (rows.length === 0) return []
    const db = await workspaceRawClient(projectId)
    if (!(await hasHelper(db, 'public.backenly_direct_create_role(text,text,text,text)'))) return []
    const state = await loginState(db, rows.map((r) => r.roleName))
    const schema = await resolveWorkspaceSchema(projectId)
    const restored: string[] = []
    for (const row of rows) {
      if (state.get(row.roleName) !== false) continue
      const password = decryptValue({ valueCipher: row.passwordCipher, valueIv: row.passwordIv, valueTag: row.passwordTag })
      await db.$queryRaw`SELECT public.backenly_direct_create_role(${row.roleName}, ${password}, ${schema}, ${row.mode})`
      restored.push(row.roleName)
    }
    if (restored.length > 0) console.log(`[DirectAccess] project=${projectId}: ${restored.length} login(s) brought back (${why})`)
    return restored
  } catch (err) {
    console.warn(`[DirectAccess] project=${projectId}: logins not brought back (${why}): ${failure(err)}; the hourly pass tries again`)
    return []
  }
}

/**
 * The hourly pass (instrumentation.ts, on the home region's scheduler): every
 * project with a login, its logins stopped if it is paused and brought back if
 * it is not, each project under its lifecycle lock so a pause or a resume
 * cannot land between the read and the change. A project whose lock is held
 * is left for the next pass. Never throws.
 */
export async function reconcileDirectLoginsWithPause(): Promise<{ stopped: number; restored: number }> {
  const { withProjectLifecycleLock, LifecycleBusyError } = await import('./pause-lifecycle')
  const projects = await prisma.databaseCredential
    .findMany({ select: { projectId: true }, distinct: ['projectId'] })
    .catch(() => [] as Array<{ projectId: string }>)
  let stopped = 0
  let restored = 0
  for (const { projectId } of projects) {
    try {
      await withProjectLifecycleLock(projectId, async (tx) => {
        const project = await tx.project.findUnique({ where: { id: projectId }, select: { pausedAt: true } })
        if (!project) return
        if (project.pausedAt) stopped += (await stopDirectLogins(projectId, 'hourly pass')).length
        else restored += (await restoreDirectLogins(projectId, 'hourly pass')).length
      })
    } catch (err) {
      if (!(err instanceof LifecycleBusyError)) console.warn(`[DirectAccess] project=${projectId}: logins not checked against its pause: ${failure(err)}`)
    }
  }
  if (stopped + restored > 0) console.log(`[DirectAccess] hourly pass: ${stopped} login(s) stopped, ${restored} brought back`)
  return { stopped, restored }
}
