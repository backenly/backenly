'use client'

/**
 * Overview — the project home, inside the ONE workspace shell.
 *
 * Post chat-door removal (2026-07-17) this page is a thin frame around
 * MainWorkspace, which fetches its own backend state (/state, /build-status)
 * and renders WorkspaceHome — the System Overview hero, tables/APIs, health
 * ("A few things to clear"), and activity. Builds arrive through the one
 * door — the user's coding agent over MCP — so there is no build mirror,
 * chat store, or prompt bridge here anymore.
 */

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { MainWorkspace } from '@/components/workspace/MainWorkspace'
import { getProjects } from '@/lib/api/projects'

export default function OverviewPage() {
  const params = useParams()
  const projectId = params.id as string

  const [projectName, setProjectName] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId) return
    getProjects()
      .then((projects) => {
        const name = projects.find((p) => p.id === projectId)?.name
        if (name) setProjectName(name)
      })
      .catch(() => {})
  }, [projectId])

  return (
    <div className="h-full flex flex-col overflow-y-auto">
      <MainWorkspace projectId={projectId} projectName={projectName} />
    </div>
  )
}
