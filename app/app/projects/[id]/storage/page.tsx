'use client'

import { useParams } from 'next/navigation'
import { useEffect } from 'react'
import { setCurrentProjectId } from '@/lib/api/client'
import { StorageWorkbench } from '@/components/storage/StorageWorkbench'

export default function ProjectStoragePage() {
  const params = useParams()
  const projectId = params.id as string

  useEffect(() => {
    if (projectId) setCurrentProjectId(projectId)
  }, [projectId])

  return <StorageWorkbench projectId={projectId} />
}
