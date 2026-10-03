export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth/middleware'
import { canWriteProject } from '@/lib/edition/guard'
import { applyChangesFromPlan, type BackendChangePlan } from '@/lib/services/aiWorkspace'
import { prisma } from '@/lib/db/postgres'
import { runMutation, mutationHttpStatus } from '@/lib/ai/build-runtime/mutate'

// POST /api/ai-workspace/apply-changes — Apply changes from a generated plan
//
// All schema/file mutations go through runMutation() to enforce:
//   budget → lock → execute → audit → trace → UI sync → release
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticateRequest(request)
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { plan, selectedChanges, projectId } = body

    if (!plan) {
      return NextResponse.json({ error: 'Plan is required' }, { status: 400 })
    }
    if (!Array.isArray(selectedChanges)) {
      return NextResponse.json({ error: 'selectedChanges must be an array' }, { status: 400 })
    }
    if (!projectId) {
      return NextResponse.json({ error: 'Project ID is required' }, { status: 400 })
    }

    // Ownership, before the project id is used for anything.
    //
    // This route authenticated the caller and then took `projectId` straight
    // from the request body, so any signed-in account could name another
    // tenant's project and apply schema changes to it. Authentication answers who is
    // asking; it says nothing about what they may touch.
    if (!(await canWriteProject(auth.userId, projectId))) {
      // 404, not 403: the endpoint must not confirm which project ids exist.
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const selectedIndices = selectedChanges.map((idx: string | number) => parseInt(String(idx), 10))

    const result = await runMutation(
      {
        projectId,
        kind:       'modify',
        action:     'workspace_apply_changes',
        userId:     auth.userId,
        auditAction: 'WORKSPACE_APPLY_CHANGES',
        // Snapshot before only if the plan contains schema mutations (not file-only changes)
        snapshotBefore: selectedIndices.some(i => {
          const change = (plan as BackendChangePlan).changes[i]
          return change?.type === 'schema' || change?.type === 'migration'
        }),
      },
      async () => {
        // Apply changes (file writes, schema mutations via aiWorkspace service)
        const applyResult = await applyChangesFromPlan(plan as BackendChangePlan, selectedIndices, projectId)

        // Persist generated files to WorkspaceFile for the inspector UI
        const filesToSave = selectedIndices.flatMap(i => {
          const change = (plan as BackendChangePlan).changes[i]
          if (!change) return []
          if ((change.type === 'endpoint' || change.type === 'file') && change.code) {
            return [{
              projectId,
              path:        change.target,
              content:     change.code,
              description: change.description || `${change.action} ${change.type}`,
            }]
          }
          return []
        })

        for (const file of filesToSave) {
          // @ts-ignore — WorkspaceFile is in the generated Prisma client
          await prisma.workspaceFile.upsert({
            where:  { projectId_path: { projectId: file.projectId, path: file.path } },
            update: { content: file.content, description: file.description, updatedAt: new Date() },
            create: file,
          })
        }

        return { applyResult, filesCreated: filesToSave.length }
      },
    )

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error ?? 'Failed to apply changes' },
        { status: mutationHttpStatus(result) },
      )
    }

    return NextResponse.json({
      result:       result.data?.applyResult,
      filesCreated: result.data?.filesCreated ?? 0,
    })
  } catch (error: any) {
    console.error('[apply-changes] Unexpected error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to apply changes' },
      { status: 500 },
    )
  }
}
