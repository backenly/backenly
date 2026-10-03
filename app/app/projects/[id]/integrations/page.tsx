'use client'

/**
 * Integrations — first-class page (was a Control Hub overlay panel).
 *
 * IA restructure §6.9: the provider registry is a real route inside the single
 * project shell. The panel renders the whole page, header included.
 *
 * Payments lives here as the Stripe connector (§6.9) — it is a connector for us,
 * not a platform primitive.
 */

import { useEffect } from 'react'
import { useParams } from 'next/navigation'
import { setCurrentProjectId } from '@/lib/api/client'
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

  return <IntegrationsPanel />
}
