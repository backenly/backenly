'use client'

/**
 * Overview: the project home (project console decision 10, 2026-11-16).
 *
 * A thin frame around MainWorkspace, which reads the project, its published
 * version and its backend state, and shows the live summary (WorkspaceHome)
 * or, with nothing built yet, connecting the agent (WorkspaceSetup). Builds
 * arrive through the one door, the user's coding agent over MCP.
 */

import { useParams } from 'next/navigation'
import { MainWorkspace } from '@/components/workspace/MainWorkspace'

export default function OverviewPage() {
  const params = useParams()
  const projectId = params.id as string
  // A document surface: the page scrolls with the window (the console frame owns scrolling).
  return <MainWorkspace projectId={projectId} />
}
