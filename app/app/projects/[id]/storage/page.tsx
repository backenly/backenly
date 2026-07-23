'use client'

import { useParams } from 'next/navigation'
import { useEffect } from 'react'
import { setCurrentProjectId } from '@/lib/api/client'
import StoragePageContent from '@/app/app/storage/page'
import { InspectorPageHeader } from '@/components/inspector/InspectorPageHeader'
import { HardDrive } from 'lucide-react'

export default function ProjectStoragePage() {
  const params = useParams()
  const projectId = params.id as string

  useEffect(() => {
    if (projectId) setCurrentProjectId(projectId)
  }, [projectId])

  return (
    <div className="min-h-screen bg-[#101116] flex flex-col">
      <InspectorPageHeader
        icon={HardDrive}
        title="Storage"
        description="File uploads · buckets · IAM access control · governed file operations"
        badge={{ label: 'Governed', variant: 'governed' }}
      />
      <div className="flex-1">
        <StoragePageContent />
      </div>
    </div>
  )
}
