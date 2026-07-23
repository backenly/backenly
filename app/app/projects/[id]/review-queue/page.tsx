'use client'

import { useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'

/**
 * Review Queue → merged into Autonomy (2026-07-18).
 *
 * The standalone queue page rendered the same pendingApprovals slice the
 * Autonomy page already reports — the same reality shown twice. Autonomy now
 * owns the whole loop story: what's waiting on you, the dial, the scoreboard,
 * the activity feed. This stub is a permanent client redirect so old
 * bookmarks, emails and in-app links keep working.
 */
export default function ReviewQueueRedirect() {
  const params = useParams()
  const router = useRouter()
  const projectId = params.id as string

  useEffect(() => {
    if (projectId) router.replace(`/app/projects/${projectId}/autonomy`)
  }, [router, projectId])

  return null
}
