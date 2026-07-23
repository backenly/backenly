'use client'

import { useParams } from 'next/navigation'
import { GitBranch } from 'lucide-react'
import { InspectorPageHeader } from '@/components/inspector/InspectorPageHeader'
import { BranchesPanel } from '@/components/branches/BranchesPanel'

/**
 * Preview Branches — "PRs for your backend." Clone the schema + data, let an
 * agent build against the copy, then merge additive changes back through the
 * governed kernel. Effectively free on Backenly's multi-tenant architecture.
 */
export default function BranchesPage() {
  const params = useParams()
  const projectId = params.id as string

  return (
    <div className="min-h-screen bg-[#101116] flex flex-col text-white">
      <InspectorPageHeader
        icon={GitBranch}
        title="Branches"
        description="Preview branches: clone your backend, experiment safely, merge back through the governed path"
        badge={{ label: 'Beta', variant: 'beta' }}
      />
      <div className="dark flex-1 overflow-y-auto px-8 py-6">
        <BranchesPanel projectId={projectId} />
      </div>
    </div>
  )
}
