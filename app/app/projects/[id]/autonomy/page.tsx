'use client'

/**
 * Autonomy — first-class page (IA restructure §6.10).
 *
 * One surface: what's waiting on you (the Review Queue, folded in
 * 2026-07-18), the autonomy dial (OFF → detect → propose → auto-apply within
 * bounds), plan cadence, trust scoreboard, the recent MAPE-K activity feed,
 * and restore points (version rollback). AutonomyGuardrailsSettings owns the
 * whole page including its header.
 *
 * The former Memory tab was removed 2026-07-16 (duplicated History), and the
 * standalone /review-queue page was merged here 2026-07-18 (it rendered the
 * same pendingApprovals slice this page already reports — the founder's rule:
 * never show the same reality twice). The TopBar inbox icon now lands here.
 */

import { useEffect } from 'react'
import { useParams } from 'next/navigation'
import { setCurrentProjectId } from '@/lib/api/client'
import { AutonomyGuardrailsSettings } from '@/components/AutonomyGuardrailsSettings'

export default function ProjectAutonomyPage() {
  const params = useParams()
  const projectId = params.id as string

  if (projectId && typeof window !== 'undefined') setCurrentProjectId(projectId)
  useEffect(() => {
    if (projectId) setCurrentProjectId(projectId)
  }, [projectId])

  return <AutonomyGuardrailsSettings projectId={projectId} />
}
