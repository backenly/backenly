'use client'

import { useParams } from 'next/navigation'
import { RealtimeWorkbench } from '@/components/realtime/RealtimeWorkbench'

export default function RealtimePage() {
  const params = useParams()
  const projectId = params.id as string

  return <RealtimeWorkbench projectId={projectId} />
}
