'use client'

/**
 * The TopBar identity chip, as resolved WITHOUT the private overlay.
 *
 * `@cloud/org-switcher` resolves here only when `lib/cloud/org-switcher.tsx` is
 * absent. The Cloud version is a real switcher: it lists every organization the
 * user belongs to, remembers the active one, and broadcasts the change. This
 * one is the static chip that switcher replaced.
 *
 * ---- WHY A CHIP RATHER THAN NOTHING --------------------------------------
 *
 * The alternative was for TopBar to render the switcher conditionally, which
 * puts an edition check in a shared shell file and leaves a gap in the layout
 * when it fails. A component that always exists and renders the right thing for
 * the build keeps the seam at the import and the shell edition-unaware.
 *
 * There is nothing to switch on a self-hosted deployment: one deployment is one
 * project, and organizations are Cloud control plane. So this shows who is
 * signed in and stops there. No dropdown affordance, no plan chip, and no
 * /api/org/list request to a route this build does not serve.
 */

/**
 * `plan` is accepted and deliberately ignored.
 *
 * The shell passes the account's plan name (usePlanName), which is always
 * empty here: a self-hosted deployment has no plan, because
 * `selfHostedEntitlements()` leaves every ceiling null. The chip once printed
 * a hardcoded "Free" and told an operator with unlimited entitlements that they
 * were on the free tier. Keeping the prop in the signature keeps this component
 * swappable with the Cloud switcher, which does render a real plan.
 */
export function OrgSwitcher({ fallbackName }: { fallbackName: string; plan?: string }) {
  return (
    <div className="relative">
      <div className="flex h-[32px] items-center gap-1.5 px-1.5">
        <span className="max-w-[160px] truncate text-[13px] font-medium text-zinc-200">{fallbackName}</span>
      </div>
    </div>
  )
}

/**
 * No active organization to remember.
 *
 * Exported so callers can ask without an edition check of their own. Null is
 * the answer every consumer already handles: it is what the Cloud switcher
 * returns before its first fetch resolves.
 */
export function getActiveOrgId(): string | null {
  return null
}
