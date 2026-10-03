'use client'

/**
 * Webhooks — a first-class project surface.
 *
 * Under Connect rather than Build: an endpoint is somewhere this project sends
 * events, which is the same category as MCP and the SDK, not a thing you build
 * inside the backend. The panel renders the whole page, header included.
 */

import { useEffect } from 'react'
import { useParams } from 'next/navigation'
import { setCurrentProjectId } from '@/lib/api/client'
import { WebhooksPanel } from '@/components/integrations/WebhooksPanel'

export default function ProjectWebhooksPage() {
  const params = useParams()
  const projectId = params.id as string

  if (projectId && typeof window !== 'undefined') setCurrentProjectId(projectId)
  useEffect(() => {
    if (projectId) setCurrentProjectId(projectId)
  }, [projectId])

  return <WebhooksPanel projectId={projectId} />
}
