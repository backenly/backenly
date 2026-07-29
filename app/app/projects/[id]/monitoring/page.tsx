'use client'

import { useParams } from 'next/navigation'
import { useEffect } from 'react'
import { setCurrentProjectId } from '@/lib/api/client'
import { MonitoringWorkbench } from '@/components/monitoring/MonitoringWorkbench'

export default function ProjectMonitoringPage() {
  const params = useParams()
  const projectId = params.id as string

  useEffect(() => {
    if (projectId) setCurrentProjectId(projectId)
  }, [projectId])

  return <MonitoringWorkbench projectId={projectId} />
}
