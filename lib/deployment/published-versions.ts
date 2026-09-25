/**
 * A project's published versions, newest first, and which one is serving.
 *
 * One authority for the Deploy page's version history (GET
 * /api/projects/[id]/rollback) and the agent's deploy { action: "history" }, so
 * the two cannot disagree about what "active" or "can roll back" means.
 */

import { prisma } from '@/lib/db/prisma'

export interface PublishedVersion {
  id: string
  version: number | null
  graphSnapshotId: string | null
  changeSummary: string
  publishedAt: string
  /** Its snapshot is the graph the project is serving right now. */
  isActive: boolean
  /** The most recently published version. */
  isCurrent: boolean
  canRollback: boolean
}

export async function listPublishedVersions(projectId: string): Promise<{
  versions: PublishedVersion[]
  currentVersion: number
  latestVersion: number
} | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, activeGraphId: true },
  })
  if (!project) return null

  const deployments = await prisma.deployment.findMany({
    where: {
      projectId,
      environment: 'live',
      status: 'live',
      version: { not: null },
    },
    orderBy: { version: 'desc' },
    select: {
      id: true,
      version: true,
      graphSnapshotId: true,
      changeSummary: true,
      completedAt: true,
      createdAt: true,
    },
  })

  // After a rollback + republish, several versions can share the same
  // graphSnapshotId; only the newest match is "active", and rolling back to a
  // snapshot that equals the live graph is a no-op the engine rejects.
  const activeIdx = deployments.findIndex(d => d.graphSnapshotId === project.activeGraphId)
  const versions = deployments.map((d, idx) => ({
    id: d.id,
    version: d.version,
    graphSnapshotId: d.graphSnapshotId,
    changeSummary: d.changeSummary || 'Published',
    publishedAt: d.completedAt?.toISOString() || d.createdAt.toISOString(),
    isActive: idx === activeIdx,
    isCurrent: idx === 0,
    canRollback: !!d.graphSnapshotId && d.graphSnapshotId !== project.activeGraphId,
  }))

  return {
    versions,
    currentVersion: versions.find(v => v.isActive)?.version || versions[0]?.version || 0,
    latestVersion: versions[0]?.version || 0,
  }
}
