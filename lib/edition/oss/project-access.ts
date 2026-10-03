/**
 * The organization half of project access, as resolved WITHOUT the private overlay.
 *
 * `@cloud/project-access` resolves here only when `lib/cloud/project-access.ts`
 * is absent, which means no Cloud overlay has been applied.
 *
 * ── What left, and what stayed ──────────────────────────────────────────────
 *
 * `lib/auth/project-access.ts` used to answer two different questions in one
 * function: does this project exist and does this caller own it (product), and
 * is this caller a member of the organization that owns it, and is that
 * membership scoped to a subset of projects (Cloud control plane). The first is
 * true of every Backenly deployment. The second describes a tenancy model that
 * only Cloud has, so it is the half that moved.
 *
 * The public half still decides. It asks this module only about a caller who is
 * NOT the owner, which is the only case an organization could change — so a
 * missing overlay can never narrow an owner's access, only decline to widen a
 * stranger's.
 *
 * ── Why "no membership" rather than a throw ─────────────────────────────────
 *
 * A real Cloud deployment cannot reach this file: it sets BACKENLY_EDITION=cloud
 * explicitly, and assertEditionCompositionOrExit refuses to start without the
 * overlay. What reaches here is the unset-edition default — CI, local
 * development, and any public checkout. For those, "this deployment has no
 * organizations" is not a degraded answer, it is the correct one.
 */

/**
 * The role a non-owner holds over a project through an organization, or null
 * when they hold none.
 *
 * Null means DENIED, and that is the honest answer for a deployment with no
 * organization layer: the only ways to reach a project here are owning it or
 * being the operator of a single-tenant install, and both are decided before
 * this is ever called.
 */
export async function organizationRoleForProject(
  _projectId: string,
  _organizationId: string | null,
  _userId: string,
): Promise<'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER' | null> {
  return null
}

/**
 * The organization clauses that widen a project listing beyond ownership.
 *
 * An empty array leaves the caller with `{ userId }` alone, which is exactly
 * what a listing meant before organizations existed.
 */
export async function organizationProjectClauses(
  _userId: string,
): Promise<Array<Record<string, unknown>>> {
  return []
}
