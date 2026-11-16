'use client'

/**
 * /app/welcome: kept so links to the first-run move flow still land. The
 * question it asked now opens on the organization's Projects page ("How do
 * you want to start?"), and moving a backend in is the organization's import
 * page, so on Backenly Cloud this forwards there with its query (?source=,
 * or the older ?from=). A self-hosted deployment has no import: /app.
 */

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useOrgPage } from '@cloud/org-routing'
import { OrgShell } from '@/components/shell/OrgShell'
import { Skeleton } from '@/components/inspector/kit'
import { PAGE_GUTTER, PAGE_WIDTH } from '@/components/console/tokens'

export default function WelcomeRedirect() {
  const router = useRouter()
  const page = useOrgPage('/import')
  useEffect(() => {
    if (page === 'stay') router.replace('/app')
  }, [page, router])
  return (
    <OrgShell>
      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} space-y-3 py-10`} aria-hidden>
        <Skeleton className="h-[22px] w-40" />
        <Skeleton className="h-[14px] w-72" />
      </div>
    </OrgShell>
  )
}
