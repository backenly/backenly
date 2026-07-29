'use client'

/**
 * Functions section. Functions are created through the user's coding agent over
 * MCP (Connect); this page manages them. The surface itself is an instrument —
 * see components/functions/FunctionsWorkbench.tsx.
 */

import { useParams } from 'next/navigation'
import { FunctionsWorkbench } from '@/components/functions/FunctionsWorkbench'

export default function FunctionsPage() {
  const params = useParams()
  const projectId = params.id as string

  return <FunctionsWorkbench projectId={projectId} />
}
