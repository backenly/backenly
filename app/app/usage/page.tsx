'use client'

/**
 * /app/usage: the account-level Usage page.
 *
 * Billing-cycle surface: it reads /api/billing/usage, which ships only with the
 * Cloud overlay, and plots consumption against plan ceilings that a
 * self-hosted deployment does not have, so a public build has no such page.
 *
 * Backenly Cloud bills per organization, so `useOrgPage` sends the account on
 * to its organization's usage (/app/org/[orgId]/usage) and this page renders
 * only a placeholder while that happens. The decision lives behind the
 * `@cloud/org-routing` seam so this page carries no edition check.
 */

import { notFound } from 'next/navigation'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { useOrgPage } from '@cloud/org-routing'
import { OrgShell } from '@/components/shell/OrgShell'
import { Skeleton } from '@/components/inspector/kit'
import { PAGE_GUTTER, PAGE_WIDTH } from '@/components/console/tokens'
import { UsageView } from '@/components/usage/UsageView'

export default function UsagePage() {
  if (!CLOUD_CONTROL_PLANE) notFound()
  return <AccountUsage />
}

function AccountUsage() {
  const page = useOrgPage('/usage')
  if (page === 'redirecting') {
    return (
      <OrgShell>
        <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} space-y-3 py-10`} aria-hidden>
          <Skeleton className="h-[22px] w-40" />
          <Skeleton className="h-[14px] w-72" />
        </div>
      </OrgShell>
    )
  }
  return <UsageView />
}
