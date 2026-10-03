export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { withAuth } from '@/lib/auth/route-protection'
import { enforceProjectCreation } from '@/lib/entitlements/policy'
import { initializeAccountEntitlements } from '@/lib/entitlements'
import { recordProductEvent } from '@/lib/platform-signals'
import { sanitizeDiagnostic } from '@/lib/errors/diagnostic-sanitize'
import { assertWritable } from '@/lib/platform-controls'
import { assertAccountCanConsume } from '@/lib/platform-controls'
import { getProjectLifecycle } from '@/lib/edition'
import { ProjectCreationUnsupportedError } from '@/lib/projects/provision'
import type { ProjectListEntry } from '@/lib/edition/types'

/**
 * THE PUBLIC PROJECT ROUTE
 * ========================
 * This route is public and deliberately thin. Which projects exist, who may see
 * them, and whether another may be created are edition questions, and they are
 * asked of ProjectLifecycle rather than answered here. Cloud's answers live in
 * the private overlay; a self-hosted deployment resolves its one project.
 *
 * What stayed: authentication, the founder kill switch, account standing, plan
 * enforcement, validation and serialisation. Those are public product policy
 * and they apply identically in both editions.
 *
 * What left: the organization attachment, the inline provisioning sequence and
 * the multi-project Prisma listing. The provisioning in particular was a second
 * complete implementation living in a route -- including a workspace block
 * pasted twice, whose second copy could only ever throw on the
 * `@@unique([projectId])` constraint and be swallowed by its own catch, logging
 * "Failed to create workspace" on every successful creation.
 */

// Validation schemas
const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  environment: z.enum(['development', 'staging', 'production']).optional(),
  apiUrlDev: z.string().url().optional().nullable(),
  apiUrlStaging: z.string().url().optional().nullable(),
  apiUrlProd: z.string().url().optional().nullable(),
  userId: z.string().uuid(),
})

/** BigInt does not survive JSON.stringify, and every listing carries four. */
function serializeProject(project: ProjectListEntry, user: { id: string; email: string; name: string | null }) {
  const { _count, ...rest } = project
  return {
    ...rest,
    storageUsed: project.storageUsed.toString(),
    storageLimit: project.storageLimit.toString(),
    maxFileSize: project.maxFileSize.toString(),
    maxFilesPerBucket: project.maxFilesPerBucket, // Already Int, not BigInt
    user,
    metrics: {
      totalFunctions: 0, // Functions feature removed
      totalTables: _count.tables,
      totalWorkspaces: _count.workspaces,
      apiRequests: project.apiRequests,
      avgLatency: project.avgLatency,
      errorCount: project.errorCount,
      storageUsed: project.storageUsed.toString(),
      activeUsers: project.activeUsers,
      lastMetricsUpdate: project.lastMetricsUpdate,
    },
  }
}

/**
 * GET /api/projects - List the projects this caller may see
 * 🔒 Protected: Requires authentication
 */
export const GET = withAuth(async (_request: NextRequest, { user }) => {
  try {
    const projects = await getProjectLifecycle().list(user.userId)

    // Use the authenticated user rather than refetching: auth already loaded it.
    const identity = { id: user.userId, email: user.email, name: (user as any).name || null }
    const data = projects.map((project) => serializeProject(project, identity))

    return NextResponse.json({ success: true, data, count: data.length })
  } catch (error: any) {
    console.error('Error fetching projects:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to fetch projects', message: sanitizeDiagnostic(error) },
      { status: 500 }
    )
  }
});

/**
 * POST /api/projects - Create a new project
 * 🔒 Protected: Requires authentication
 */
export const POST = withAuth(async (request: NextRequest, { user }) => {
  try {
    // Founder kill switch: maintenance / read-only mode blocks new projects.
    const writeGuard = await assertWritable()
    if (!writeGuard.ok) {
      return NextResponse.json({ error: writeGuard.reason }, { status: writeGuard.status })
    }

    // Anti-abuse: an account flagged untrusted at signup provisions nothing
    // until it verifies its mailbox. No-op for every normal user.
    const standing = await assertAccountCanConsume(user.userId)
    if (!standing.ok) {
      return NextResponse.json(
        { success: false, error: standing.reason, code: standing.code },
        { status: standing.status },
      )
    }

    const body = await request.json()
    const validatedData = createProjectSchema.parse(body)

    // ─── Plan enforcement: project limit ─────────────────────────────────────
    const existingCount = await prisma.project.count({ where: { userId: user.userId } })

    // Give a first-time account whatever entitlements it needs. A no-op in
    // single-tenant, where entitlements come from the edition rather than a row.
    await initializeAccountEntitlements(user.userId)

    const limitCheck = await enforceProjectCreation(user.userId, existingCount)
    if (limitCheck !== true) {
      return NextResponse.json(
        {
          success: false,
          error: limitCheck.message,
          code: limitCheck.code,
          upgradeRequired: limitCheck.upgradeRequired,
          currentPlan: limitCheck.currentPlan,
          requiredPlan: limitCheck.requiredPlan,
        },
        { status: 403 }
      )
    }

    const { project, apiKey } = await getProjectLifecycle().create({
      name: validatedData.name,
      description: validatedData.description ?? null,
      environment: validatedData.environment,
      apiUrlDev: validatedData.apiUrlDev,
      apiUrlStaging: validatedData.apiUrlStaging,
      apiUrlProd: validatedData.apiUrlProd,
      userId: user.userId,
    })

    // Track project_created event (non-blocking)
    recordProductEvent({ type: 'project_created', userId: user.userId, projectId: project.id, metadata: { name: project.name } })

    return NextResponse.json(
      {
        success: true,
        data: serializeProject(
          project,
          project.user ?? { id: user.userId, email: user.email, name: (user as any).name || null },
        ),
        // Returned ONCE at creation. Never stored in the database.
        apiKey,
      },
      { status: 201 }
    )
  } catch (error: any) {
    if (error instanceof ProjectCreationUnsupportedError) {
      // One deployment is one project. This is architectural rather than a
      // limit, so it is not an upgrade prompt and there is no plan that lifts it.
      return NextResponse.json(
        { success: false, error: error.message, code: error.code },
        { status: 403 }
      )
    }

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: 'Validation error', details: error.errors },
        { status: 400 }
      )
    }

    console.error('Error creating project:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to create project', message: sanitizeDiagnostic(error) },
      { status: 500 }
    )
  }
});
