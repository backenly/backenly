'use client'

/**
 * Integrations — first-class page (was a Control Hub overlay panel).
 *
 * IA restructure §6.9: the provider registry UI moves from the
 * `?hub=integrations` overlay to a real route. Content is unchanged — the same
 * `IntegrationsPanel` that rendered inside the hub renders here, now inside the
 * single project shell (TopBar + ProjectSidebar) instead of a modal.
 *
 * Payments lives here as the Stripe connector (§6.9) — it is a connector for us,
 * not a platform primitive.
 */

import { useEffect } from 'react'
import { useParams } from 'next/navigation'
import { Zap } from 'lucide-react'
import { setCurrentProjectId } from '@/lib/api/client'
import { InspectorPageHeader } from '@/components/inspector/InspectorPageHeader'
import { IntegrationsPanel } from '@/components/hub/IntegrationsPanel'

export default function ProjectIntegrationsPage() {
  const params = useParams()
  const projectId = params.id as string

  // Panel self-sources projectId via useParams, but several downstream API
  // clients read the current-project cache — set it synchronously to avoid a
  // first-render fetch against a stale id.
  if (projectId && typeof window !== 'undefined') setCurrentProjectId(projectId)
  useEffect(() => {
    if (projectId) setCurrentProjectId(projectId)
  }, [projectId])

  return (
    <div className="min-h-screen bg-[#101116] flex flex-col">
      <InspectorPageHeader
        icon={Zap}
        title="Integrations"
        description="Connect API keys once. Every provider becomes callable from functions, triggers, and the agent via ctx.integrations."
        badge={{ label: 'Governed', variant: 'governed' }}
      />
      <div className="flex-1">
        <IntegrationsPanel />
      </div>
    </div>
  )
}
