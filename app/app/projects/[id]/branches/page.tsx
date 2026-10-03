'use client'

import { notFound, useParams } from 'next/navigation'
import { BranchesPanel } from '@/components/branches/BranchesPanel'
import { PageHeader, Tag } from '@/components/inspector/kit'
import { PAGE_GUTTER, PAGE_WIDTH } from '@/components/console/tokens'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'

/**
 * Preview Branches: "PRs for your backend." Clone the schema and data, let an
 * agent build against the copy, then merge additive changes back through the
 * governed kernel.
 */
export default function BranchesPage() {
  const params = useParams()
  const projectId = params.id as string

  // The nav no longer links here off Cloud, but a typed URL or an old
  // bookmark still resolves. Without this the page would render a shell whose
  // every call answers 404.
  if (!CLOUD_CONTROL_PLANE) notFound()

  return (
    <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>
      <PageHeader
        className="!px-0"
        title="Branches"
        meta={<Tag tone="violet">Beta</Tag>}
        description="Clone your backend, schema and data, so an agent can build against the copy. New tables merge back through the governed path; anything else comes back for review."
      />
      <BranchesPanel projectId={projectId} />
    </div>
  )
}
