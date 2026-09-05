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
 * signed in and stops there. No dropdown affordance, no /api/org/list request
 * to a route this build does not serve.
 */

export function OrgSwitcher({ fallbackName, plan }: { fallbackName: string; plan: string }) {
  return (
    <div className="relative">
      <div className="flex items-center gap-1.5 px-1.5 h-8 rounded-md">
        <span className="text-[12.5px] text-zinc-300 truncate max-w-[140px]">{fallbackName}</span>
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-white/[0.05] text-zinc-400 tracking-tight">
          {plan}
        </span>
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
