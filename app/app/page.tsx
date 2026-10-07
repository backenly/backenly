'use client'

/**
 * /app: where a signed-in account lands.
 *
 * Single-tenant shows its projects here. Backenly Cloud scopes the console to
 * an organization, so `useOrgHome` sends the account on to its organization's
 * projects, or to create its first organization before it has one, and this
 * page renders only a placeholder while that happens. The decision lives
 * behind the `@cloud/org-routing` seam so this page carries no edition check.
 */

import { OrgShell } from '@/components/shell/OrgShell'
import { Skeleton } from '@/components/inspector/kit'
import { PAGE_GUTTER, PAGE_WIDTH } from '@/components/console/tokens'
import { ProjectsHome } from '@/components/projects/ProjectsHome'
import { useOrgHome } from '@cloud/org-routing'

export default function DashboardPage() {
  const home = useOrgHome()
  if (home === 'redirecting') {
    return (
      <OrgShell>
        <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} space-y-3 py-10`} aria-hidden>
          <Skeleton className="h-[22px] w-40" />
          <Skeleton className="h-[14px] w-72" />
        </div>
      </OrgShell>
    )
  }
  return <ProjectsHome />
}
