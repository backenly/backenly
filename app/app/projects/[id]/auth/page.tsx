'use client'

/**
 * Auth & Users — merged section (IA restructure §6.5). The standalone /users
 * route folds in here as a tab. The surface itself lives in
 * components/auth/AuthWorkbench.tsx.
 *
 * setCurrentProjectId is called synchronously in render (not only in an effect)
 * so the configuration tab's first-mount fetch sees the correct project id.
 */

import { useEffect } from 'react'
import { useParams } from 'next/navigation'
import { setCurrentProjectId } from '@/lib/api/client'
import { AuthWorkbench } from '@/components/auth/AuthWorkbench'

export default function ProjectAuthPage() {
  const params = useParams()
  const projectId = params.id as string

  if (projectId && typeof window !== 'undefined') setCurrentProjectId(projectId)
  useEffect(() => {
    if (projectId) setCurrentProjectId(projectId)
  }, [projectId])

  return <AuthWorkbench projectId={projectId} />
}
