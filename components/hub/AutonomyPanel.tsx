'use client'

import { useParams } from 'next/navigation'
import { AutonomyGuardrailsSettings } from '@/components/AutonomyGuardrailsSettings'

export function AutonomyPanel() {
  const params = useParams()
  const projectId = (params.id ?? params.projectId) as string

  return <AutonomyGuardrailsSettings projectId={projectId} />

}
