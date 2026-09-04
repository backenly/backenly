export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { runSecurityScan, createSecurityIssues } from '@/lib/services/securityScanner'
import { canAccessProject, canWriteProject } from '@/lib/edition/guard'

const querySchema = z.object({
  page: z.string().optional().transform((val) => (val ? parseInt(val, 10) : 1)),
  limit: z.string().optional().transform((val) => (val ? parseInt(val, 10) : 50)),
  scanType: z.string().optional(),
  status: z.string().optional(),
  projectId: z.string().optional(),
})

const createScanSchema = z.object({
  scanType: z.enum(['configuration', 'vulnerability', 'compliance']),
  projectId: z.string().optional(),
})

/**
 * GET /api/security/scans - List security scans
 * 🔒 Protected: Requires authentication
 */
export const GET = withAuth(async (request: NextRequest, { user }) => {
  try {
    const searchParams = request.nextUrl.searchParams
    const params = querySchema.parse({
      page: searchParams.get('page') || undefined,
      limit: searchParams.get('limit') || undefined,
      scanType: searchParams.get('scanType') || undefined,
      status: searchParams.get('status') || undefined,
      projectId: searchParams.get('projectId') || undefined,
    })

    // If projectId provided, verify ownership
    if (params.projectId) {
      if (!(await canAccessProject(user.userId, params.projectId))) {
        return NextResponse.json(
          { error: 'Invalid project access' },
          { status: 403 }
        )
      }
    }

    const page = params.page || 1
    const limit = Math.min(params.limit || 50, 100)
    const skip = (page - 1) * limit

    const where: any = {}

    if (params.scanType) {
      where.scanType = params.scanType
    }

    if (params.status) {
      where.status = params.status
    }

    if (params.projectId) {
      where.projectId = params.projectId
    }

    const [scans, total] = await Promise.all([
      prisma.securityScan.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip,
        take: limit,
        include: {
          project: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      }),
      prisma.securityScan.count({ where }),
    ])

    return NextResponse.json({
      scans,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (error: any) {
    console.error('Error fetching security scans:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to fetch security scans' },
      { status: 500 }
    )
  }
});

/**
 * POST /api/security/scans - Create and run a security scan
 * 🔒 Protected: Requires authentication
 */
export const POST = withAuth(async (request: NextRequest, { user }) => {
  try {
    const body = await request.json()
    const data = createScanSchema.parse(body)

    // If projectId provided, verify ownership
    if (data.projectId) {
      if (!(await canWriteProject(user.userId, data.projectId))) {
        return NextResponse.json(
          { error: 'Invalid project access' },
          { status: 403 }
        )
      }
    }

    // Create scan record
    const scan = await prisma.securityScan.create({
      data: {
        scanType: data.scanType,
        status: 'running',
        projectId: data.projectId,
      },
    })

    // Run scan asynchronously
    runSecurityScan(data.scanType, data.projectId)
      .then(async (result) => {
        // Create security issues from scan results
        await createSecurityIssues(result.issues, data.projectId)

        // Update scan record
        await prisma.securityScan.update({
          where: { id: scan.id },
          data: {
            status: 'completed',
            completedAt: new Date(),
            issuesFound: result.issues.length,
            score: result.score,
            metadata: {
              issues: result.issues.map((issue) => ({
                severity: issue.severity,
                title: issue.title,
                category: issue.category,
              })),
            },
          },
        })
      })
      .catch(async (error) => {
        console.error('Security scan failed:', error)
        await prisma.securityScan.update({
          where: { id: scan.id },
          data: {
            status: 'failed',
            completedAt: new Date(),
            error: error.message,
          },
        })
      })

    return NextResponse.json(scan)
  } catch (error: any) {
    console.error('Error creating security scan:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to create security scan' },
      { status: 500 }
    )
  }
});

