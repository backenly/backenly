'use client'

import { notFound, useParams, useSearchParams } from 'next/navigation'
import { BranchesPanel } from '@/components/branches/BranchesPanel'
import { PAGE_GUTTER, PAGE_WIDTH } from '@/components/console/tokens'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'

/**
 * Preview Branches: "PRs for your backend." Clone the schema (and, when asked,
 * its rows), let an agent build against the copy, and merging replays the
 * branch's logged statements onto production after a person approves.
 *
 * One route, two views: the list, and one branch on its own page at
 * ?branch=<id> (project decision 6). BranchesPanel draws both, so moving
 * between them keeps what was read.
 */
export default function BranchesPage() {
  const params = useParams()
  const search = useSearchParams()
  const projectId = params.id as string
  const branchId = search?.get('branch') || null

  // The nav no longer links here off Cloud, but a typed URL or an old
  // bookmark still resolves. Without this the page would render a shell whose
  // every call answers 404.
  if (!CLOUD_CONTROL_PLANE) notFound()

  return (
    <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>
      <BranchesPanel projectId={projectId} branchId={branchId} />
    </div>
  )
}
