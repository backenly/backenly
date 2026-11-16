'use client'

/**
 * Database: the project's tables, SQL, schema, types, extensions and
 * snapshots. The page itself lives in components/database/DatabaseWorkbench;
 * this route only names the project.
 *
 * Every change made here goes through the same governed paths the agent's do
 * (tables and columns through the change ledger, so History can undo them);
 * row edits and deletes are direct and final, and their confirms say so.
 */

import { useEffect } from 'react'
import { useParams } from 'next/navigation'
import { setCurrentProjectId } from '@/lib/api/client'
import { DatabaseWorkbench } from '@/components/database/DatabaseWorkbench'

export default function ProjectDatabasePage() {
  const { id: projectId } = useParams<{ id: string }>()

  useEffect(() => {
    if (projectId) setCurrentProjectId(projectId)
  }, [projectId])

  if (!projectId) return null
  return <DatabaseWorkbench projectId={projectId} />
}
