'use client'

import { useParams } from 'next/navigation'
import { useEffect } from 'react'
import { setCurrentProjectId } from '@/lib/api/client'
import MonitoringPageContent from '@/app/app/monitoring/page'
import { InspectorPageHeader } from '@/components/inspector/InspectorPageHeader'
import { Activity } from 'lucide-react'

export default function ProjectMonitoringPage() {
  const params = useParams()
  const projectId = params.id as string

  useEffect(() => {
    if (projectId) setCurrentProjectId(projectId)
  }, [projectId])

  return (
    <div className="min-h-screen bg-[#101116] flex flex-col">
      <InspectorPageHeader
        icon={Activity}
        title="Monitoring"
        description="Runtime metrics, anomaly detection, and incident timeline"
        badge={{ label: 'Live', variant: 'live' }}
      />
      <div className="flex-1">
        <MonitoringPageContent projectId={projectId} />
      </div>
    </div>
  )
}
