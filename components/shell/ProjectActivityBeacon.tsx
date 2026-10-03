'use client'

/**
 * Tells the server, once, that a member opened this project's console.
 *
 * One POST per project per page load, and never on an interval: the point is
 * to count a person choosing to open the project, not a tab left open. See
 * app/api/projects/[id]/activity/route.ts for why dashboard reads do not count
 * on their own. Fire-and-forget; a failure changes nothing the user can see.
 */

import { useEffect } from 'react'
import { useParams } from 'next/navigation'

export function ProjectActivityBeacon() {
  const params = useParams()
  const projectId = typeof params?.id === 'string' ? params.id : null

  useEffect(() => {
    if (!projectId) return
    fetch(`/api/projects/${projectId}/activity`, {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
    }).catch(() => {})
  }, [projectId])

  return null
}
