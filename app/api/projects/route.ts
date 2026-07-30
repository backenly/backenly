export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { generateUniqueSlug } from '@/lib/utils/slug'
import { withAuth } from '@/lib/auth/route-protection'
import crypto from 'crypto'
import { enforceProjectCreation, createFreeSubscription, getUserSubscription } from '@/lib/billing'
import { logEvent } from '@/lib/analytics/logger'
import { sanitizeDiagnostic } from '@/lib/errors/diagnostic-sanitize'
import { assertWritable } from '@/lib/platform/controls'
import { assertAccountCanConsume } from '@/lib/auth/account-standing'
import { ensureSchemaRegistered } from '@/lib/postgrest/registration'

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

const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional().nullable(),
  environment: z.enum(['development', 'staging', 'production']).optional(),
  apiUrlDev: z.string().url().optional().nullable(),
  apiUrlStaging: z.string().url().optional().nullable(),
  apiUrlProd: z.string().url().optional().nullable(),
})

/**
 * GET /api/projects - List all projects
 * 🔒 Protected: Requires authentication, scoped to current user
 * ⚡ Optimized: Uses select instead of include for better query performance
 */
export const GET = withAuth(async (request: NextRequest, { user }) => {
  try {
    // Projects the user owns OR can reach through an org membership (Phase 6).
    // The org clause matches nothing for org-less projects, so solo users see
    // exactly what they always did.
    //
    // Project-scoped members (Pro+): a member marked `restricted` must only see
    // the projects granted to them — so the org clause requires `restricted:
    // false`, and a second clause adds back exactly their granted projects. A
    // restricted member with no grants sees nothing from the org. The two
    // clauses are evaluated per-project against that project's own org, so a
    // user restricted in one org and org-wide in another resolves correctly.
    // ⚡ OPTIMIZATION: Use select instead of include to reduce queries
    // We already have user info from auth, no need to refetch it!
    const projects = await prisma.project.findMany({
      where: {
        OR: [
          { userId: user.userId },
          { organization: { members: { some: { userId: user.userId, restricted: false } } } },
          { projectMembers: { some: { userId: user.userId } } },
        ],
      },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        userId: true,
        publicEnabled: true,
        projectStatus: true,
        deployedAt: true,
        environment: true,
        apiUrlDev: true,
        apiUrlStaging: true,
        apiUrlProd: true,
        apiRequests: true,
        avgLatency: true,
        errorCount: true,
        storageUsed: true,
        storageLimit: true,
        maxFileSize: true,
        maxFilesPerBucket: true,
        activeUsers: true,
        lastMetricsUpdate: true,
        createdAt: true,
        updatedAt: true,
        // Only count related records, don't fetch full data
        _count: {
          select: {
            tables: true,
            workspaces: true,
          },
        },
      },
      orderBy: {
        updatedAt: 'desc',
      },
    })

    // Calculate metrics for each project and serialize BigInt properly
    const projectsWithMetrics = projects.map((project) => {
      // Convert BigInt to number/string for JSON serialization
      const serializedProject = {
        ...project,
        storageUsed: project.storageUsed.toString(),
        storageLimit: project.storageLimit.toString(),
        maxFileSize: project.maxFileSize.toString(),
        maxFilesPerBucket: project.maxFilesPerBucket, // Already Int, not BigInt
        // Use authenticated user data instead of refetching
        user: {
          id: user.userId,
          email: user.email,
          name: (user as any).name || null, // User might not have name field
        },
        metrics: {
          totalFunctions: 0, // Functions feature removed
          totalTables: project._count.tables,
          totalWorkspaces: project._count.workspaces,
          apiRequests: project.apiRequests,
          avgLatency: project.avgLatency,
          errorCount: project.errorCount,
          storageUsed: project.storageUsed.toString(),
          activeUsers: project.activeUsers,
          lastMetricsUpdate: project.lastMetricsUpdate,
        },
      }
      // Remove _count from response
      const { _count, ...rest } = serializedProject
      return rest
    })

    return NextResponse.json({
      success: true,
      data: projectsWithMetrics,
      count: projectsWithMetrics.length,
    })
  } catch (error: any) {
    console.error('Error fetching projects:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch projects',
        message: sanitizeDiagnostic(error),
      },
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

    // Auto-provision a FREE subscription for first-time users
    const sub = await getUserSubscription(user.userId)
    if (!sub) await createFreeSubscription(user.userId)

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

    // Generate unique slug from project name
    const slug = await generateUniqueSlug(validatedData.name, async (checkSlug) => {
      const existing = await prisma.project.findUnique({
        where: { slug: checkSlug },
      });
      return !!existing;
    });

    // New projects belong to the creator's personal org from day one (Phase 6).
    // Non-fatal: an org-less project still works via the userId fallback.
    let organizationId: string | null = null
    try {
      const { ensurePersonalOrg } = await import('@/lib/org')
      organizationId = await ensurePersonalOrg(user.userId)
    } catch (e: any) {
      console.warn('[projects] personal org attach skipped:', e?.message)
    }

    // ATOMIC: Create project + initial graph in single transaction
    const project = await prisma.$transaction(async (tx) => {
      // Step 1: Create project
      const newProject = await tx.project.create({
        data: {
          name: validatedData.name,
          slug,
          description: validatedData.description,
          environment: validatedData.environment || 'development',
          apiUrlDev: validatedData.apiUrlDev,
          apiUrlStaging: validatedData.apiUrlStaging,
          apiUrlProd: validatedData.apiUrlProd,
          userId: user.userId,
          organizationId,
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
            },
          },
          tables: true,
          workspaces: true,
        },
      })
      
      // Step 2: Create initial BackendGraph (atomic with project creation)
      const { createEmptyGraph } = await import('@/lib/orchestration/backend-state-graph')
      const initialGraph = createEmptyGraph(newProject.id)
      
      const backendGraph = await tx.backendGraph.create({
        data: {
          projectId: newProject.id,
          graphData: initialGraph as any,
          sequenceNumber: 1, // Initial graph
        },
      })
      
      // Step 3: Set activeGraphId
      await tx.project.update({
        where: { id: newProject.id },
        data: { activeGraphId: backendGraph.id },
      })
      
      console.log(`✅ Created initial BackendGraph for project: ${newProject.id}`)
      
      return newProject
    })

    // Create workspace with isolated database schema
    try {
      const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
      const dbNames = getWorkspaceDatabaseNames(project.id)
      const postgresSchema = dbNames.postgresSchema
      
      // Create PostgreSQL schema
      const sanitizedSchema = postgresSchema.replace(/"/g, '""')
      await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${sanitizedSchema}"`)
      
      // Create workspace record
      await prisma.workspace.create({
        data: {
          name: `${project.name} Workspace`,
          projectId: project.id,
          userId: user.userId,
          postgresSchema,
          databaseProvisioned: true,
          databaseProvisionedAt: new Date(),
        },
      })
      
      // Tell PostgREST the schema exists. Without this the project's entire
      // /db/* plane answers PGRST106 on every table, forever — which is what
      // shipped for months, because this call did not exist on ANY creation
      // path. An event trigger now covers CREATE SCHEMA as well; this stays
      // because `IF NOT EXISTS` against an already-present schema fires no
      // trigger, and because a repair should not depend on one mechanism.
      await ensureSchemaRegistered(project.id)

      console.log(`✅ Created workspace with schema: ${postgresSchema}`)
    } catch (workspaceError) {
      console.error('Failed to create workspace:', workspaceError)
      // Don't fail project creation if workspace creation fails
    }

    // Seed the end-user auth signing secret so built-in auth works from day
    // zero. Non-fatal: the signup route also provisions it lazily on first use.
    try {
      const { JWTSecretManager } = await import('@/lib/services/jwtSecretManager')
      await JWTSecretManager.getOrCreateSecret(project.id)
    } catch (jwtError: any) {
      console.error('Failed to seed jwtSecret:', jwtError?.message ?? jwtError)
    }

    // Auto-generate default API key for the project
    // Plaintext key returned once in the response — never stored in DB
    let generatedApiKey: string | null = null
    try {
      const apiKeyPrefix = 'sk_live_'
      const randomBytes = crypto.randomBytes(32).toString('hex')
      generatedApiKey = `${apiKeyPrefix}${randomBytes}`
      const keyHash = crypto.createHash('sha256').update(generatedApiKey).digest('hex')

      await prisma.apiKey.create({
        data: {
          name: `${project.name} Default Key`,
          key: generatedApiKey, // Stored in plaintext — this is a PUBLIC key meant to be embedded in frontend code
          keyHash, // SHA-256 hash used for fast O(1) auth lookup
          keyPrefix: apiKeyPrefix,
          keyType: 'public',
          role: 'admin',
          permissions: [],
          capabilities: ['database', 'auth', 'storage', 'functions', 'ai'],
          serviceRole: false,
          projectId: project.id,
          userId: user.userId,
          rateLimit: 1000,
          rateLimitWindow: 3600, // 1 hour
        },
      })

      console.log(`✅ Auto-generated API key for project: ${project.id}`)
    } catch (apiKeyError) {
      console.error('Failed to generate API key:', apiKeyError)
      // Don't fail project creation if API key generation fails
    }

    // Create workspace with isolated database schema
    try {
      const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
      const dbNames = getWorkspaceDatabaseNames(project.id)
      const postgresSchema = dbNames.postgresSchema
      
      // Create PostgreSQL schema
      const sanitizedSchema = postgresSchema.replace(/"/g, '""')
      await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${sanitizedSchema}"`)
      
      // Create workspace record
      await prisma.workspace.create({
        data: {
          name: `${project.name} Workspace`,
          projectId: project.id,
          userId: user.userId,
          postgresSchema,
          databaseProvisioned: true,
          databaseProvisionedAt: new Date(),
        },
      })
      
      // Tell PostgREST the schema exists. Without this the project's entire
      // /db/* plane answers PGRST106 on every table, forever — which is what
      // shipped for months, because this call did not exist on ANY creation
      // path. An event trigger now covers CREATE SCHEMA as well; this stays
      // because `IF NOT EXISTS` against an already-present schema fires no
      // trigger, and because a repair should not depend on one mechanism.
      await ensureSchemaRegistered(project.id)

      console.log(`✅ Created workspace with schema: ${postgresSchema}`)
    } catch (workspaceError) {
      console.error('Failed to create workspace:', workspaceError)
      // Don't fail project creation if workspace creation fails
    }

    // Serialize BigInt to number for JSON response
    const serializedProject = {
      ...project,
      storageUsed: Number(project.storageUsed),
      storageLimit: Number(project.storageLimit),
      maxFileSize: Number(project.maxFileSize),
      maxFilesPerBucket: project.maxFilesPerBucket, // Already Int, not BigInt
      metrics: {
        totalFunctions: 0,
        totalTables: 0,
        totalWorkspaces: 0,
        apiRequests: project.apiRequests,
        avgLatency: project.avgLatency,
        errorCount: project.errorCount,
        storageUsed: Number(project.storageUsed),
        activeUsers: project.activeUsers,
        lastMetricsUpdate: project.lastMetricsUpdate,
      },
    }

    // Track project_created event (non-blocking)
    logEvent('project_created', user.userId, project.id, { name: project.name })

    return NextResponse.json(
      {
        success: true,
        data: serializedProject,
        // Return plaintext API key ONCE at creation — never stored in DB
        apiKey: generatedApiKey,
      },
      { status: 201 }
    )
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          success: false,
          error: 'Validation error',
          details: error.errors,
        },
        { status: 400 }
      )
    }

    console.error('Error creating project:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to create project',
        message: sanitizeDiagnostic(error),
      },
      { status: 500 }
    )
  }
});

