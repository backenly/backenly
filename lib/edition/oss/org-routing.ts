/**
 * Organization routing, as resolved WITHOUT the private overlay.
 *
 * `@cloud/org-routing` resolves here only when `lib/cloud/org-routing.tsx` is
 * absent. Cloud scopes the console to an organization: /app sends a signed-in
 * account to its organization's projects (or, before it has one, to create
 * it), and the org-level navigation points at that organization's pages.
 *
 * A self-hosted deployment has one project and no organizations, so /app stays
 * where it is and the navigation keeps its account-level links. Both answers
 * are hooks so the shell can call them without an edition check of its own.
 */

export type OrgHome = 'stay' | 'redirecting'

/** Where /app should be. Here, always /app itself. */
export function useOrgHome(): OrgHome {
  return 'stay'
}

export interface OrgHrefs {
  projects: string
  members: string
}

/** The org-level navigation targets. Here, the account-level pages. */
export function useOrgHrefs(): OrgHrefs {
  return { projects: '/app', members: '/app/members' }
}
