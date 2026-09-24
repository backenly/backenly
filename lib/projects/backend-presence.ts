/**
 * Is there a backend here to watch?
 *
 * One answer, read by every autonomy entry point before it spends a cycle on a
 * project or files anything against it: the observer, the contract sweep, the
 * data-plane liveness invariant, the dashboard's first-scan kick and the event
 * bus.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * A customer created a project, never connected an agent, and minutes later was
 * emailed a critical "contract surface broken" alert. Nothing had been built.
 * The dashboard's first `/health` poll had started a full observer scan with no
 * gate at all, and the contract verifier probed the auth surface because a
 * signing secret is seeded at creation. Each entry point had its own idea of
 * "worth checking" (the sweep asked "has a table", the observer asked nothing),
 * and the one that asked nothing is the one that emailed.
 *
 * ── What counts as built ────────────────────────────────────────────────────
 *
 * Only things a developer or their agent actually created. Provisioning state
 * never counts:
 *
 *   counts   a table other than the auth-managed `users` table and reserved
 *            `_`/`pg_` plumbing (every generated API hangs off one), an AI
 *            function, a storage bucket, an app trigger, a webhook, an enabled
 *            OAuth provider, or email auth enabled in the active backend graph
 *   never    the seeded jwtSecret, the anon key, the empty graph, the workspace
 *            schema, a `users` table standing alone, or monthly-active-user
 *            rows. The contract probe's synthetic sign-ins used to record
 *            those, so a row cannot prove a real person was ever there.
 *
 * This is the same line `app/api/projects/[id]/state` draws for `hasContent`
 * and `getEndUserAuthUsage` draws for auth, expressed as one Prisma filter so a
 * scheduler can select every watchable project in a single query.
 *
 * Locked-down and paused projects are excluded as well. Both refuse every
 * runtime request on purpose (lib/projects/serving-state.ts), so probing one
 * would report the refusal working as an outage, and autonomy must not mutate a
 * sealed project or spend on one nobody is using.
 */

import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'

/**
 * A literal prefix for a Prisma `startsWith`.
 *
 * Prisma hands the value to LIKE unescaped, and `_` is LIKE's single-character
 * wildcard, so `startsWith: '_'` matches every non-empty name. Measured on the
 * test database: 39 of 39 tables matched it. Written that way, "not a reserved
 * table" would exclude every table and no project would ever count as built.
 */
function literalPrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** Evidence that something was genuinely built. Carries no lifecycle filter. */
export function builtEvidenceWhere(): Prisma.ProjectWhereInput {
  return {
    OR: [
      {
        tables: {
          some: {
            AND: [
              { NOT: { name: { equals: 'users', mode: 'insensitive' } } },
              { NOT: { name: { startsWith: literalPrefix('_') } } },
              { NOT: { name: { startsWith: literalPrefix('pg_'), mode: 'insensitive' } } },
            ],
          },
        },
      },
      { aiFunctions: { some: {} } },
      { storageBuckets: { some: {} } },
      { appTriggers: { some: {} } },
      { webhooks: { some: {} } },
      { workspaceOAuthConfigs: { some: { enabled: true } } },
      { activeGraph: { graphData: { path: ['auth', 'providers', 'email', 'enabled'], equals: true } } },
    ],
  }
}

/**
 * Projects autonomy may watch right now: alive, serving, and built.
 * Compose into a scheduler's `where` rather than restating any part of it.
 */
export function watchableProjectsWhere(now: Date = new Date()): Prisma.ProjectWhereInput {
  return {
    deletedAt: null,
    lockedDownAt: null,
    // Always NULL on a self-hosted deployment, where nothing pauses.
    pausedAt: null,
    AND: [
      { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      builtEvidenceWhere(),
    ],
  }
}

/** The single-project form of `watchableProjectsWhere`. */
export async function isWatchableProject(projectId: string): Promise<boolean> {
  const count = await prisma.project.count({
    where: { id: projectId, ...watchableProjectsWhere() },
  })
  return count > 0
}
