export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { addCustomDomain, getProjectDomains, deleteDomain, verifyDomain, isValidDomain, isReservedDomain } from '@/lib/domains'
import { enforceCustomDomain } from '@/lib/billing'
import { prisma } from '@/lib/db/prisma'

/**
 * GET /api/projects/[id]/domains
 * List all custom domains for a project
 * 🔒 Protected: Requires authentication + PRO plan
 */
export const GET = withAuth(async (request: NextRequest, { user, params }) => {
  try {
    const { id: projectId } = await params

    // Check if user owns this project
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: user.userId }
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Enforce PRO plan requirement
    const entitlementCheck = await enforceCustomDomain(user.userId)
    if (entitlementCheck !== true) {
      return NextResponse.json({
        error: 'Custom domains require PRO plan',
        code: 'PLAN_LIMIT_EXCEEDED',
        upgradeRequired: true,
        currentPlan: entitlementCheck.currentPlan,
        requiredPlan: 'PRO'
      }, { status: 403 })
    }

    const domains = await getProjectDomains(projectId)

    return NextResponse.json({ domains })

  } catch (error: any) {
    console.error('[Domains GET] Error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to fetch domains' },
      { status: 500 }
    )
  }
})

/**
 * POST /api/projects/[id]/domains
 * Add a new custom domain
 * 🔒 Protected: Requires authentication + PRO plan
 */
export const POST = withAuth(async (request: NextRequest, { user, params }) => {
  try {
    const { id: projectId } = await params
    const body = await request.json()
    const { domain } = body

    // Validate input
    if (!domain) {
      return NextResponse.json(
        { error: 'Domain is required' },
        { status: 400 }
      )
    }

    // Validate domain format
    if (!isValidDomain(domain)) {
      return NextResponse.json(
        { error: 'Invalid domain format' },
        { status: 400 }
      )
    }

    // Check reserved domains
    if (isReservedDomain(domain)) {
      return NextResponse.json(
        { error: 'This domain is reserved and cannot be used' },
        { status: 400 }
      )
    }

    // Check if user owns this project
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: user.userId }
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Enforce PRO plan requirement
    const entitlementCheck = await enforceCustomDomain(user.userId)
    if (entitlementCheck !== true) {
      return NextResponse.json({
        error: 'Custom domains require PRO plan',
        code: 'PLAN_LIMIT_EXCEEDED',
        upgradeRequired: true,
        currentPlan: entitlementCheck.currentPlan,
        requiredPlan: 'PRO'
      }, { status: 403 })
    }

    const customDomain = await addCustomDomain(projectId, domain)

    return NextResponse.json({
      domain: {
        id: customDomain.id,
        domain: customDomain.domain,
        verified: customDomain.verified,
        active: customDomain.active,
        dnsRecord: {
          type: 'TXT',
          name: customDomain.domain,
          value: customDomain.dnsRecordValue
        },
        createdAt: customDomain.createdAt
      }
    }, { status: 201 })

  } catch (error: any) {
    console.error('[Domains POST] Error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to add domain' },
      { status: 500 }
    )
  }
})

/**
 * DELETE /api/projects/[id]/domains
 * Delete a custom domain
 * 🔒 Protected: Requires authentication + PRO plan
 */
export const DELETE = withAuth(async (request: NextRequest, { user, params }) => {
  try {
    const { id: projectId } = await params
    const { searchParams } = new URL(request.url)
    const domainId = searchParams.get('domainId')

    if (!domainId) {
      return NextResponse.json(
        { error: 'domainId is required' },
        { status: 400 }
      )
    }

    // Check if user owns this project
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: user.userId }
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Enforce PRO plan requirement
    const entitlementCheck = await enforceCustomDomain(user.userId)
    if (entitlementCheck !== true) {
      return NextResponse.json({
        error: 'Custom domains require PRO plan',
        code: 'PLAN_LIMIT_EXCEEDED',
        upgradeRequired: true,
        currentPlan: entitlementCheck.currentPlan,
        requiredPlan: 'PRO'
      }, { status: 403 })
    }

    await deleteDomain(domainId, projectId)

    return NextResponse.json({ success: true })

  } catch (error: any) {
    console.error('[Domains DELETE] Error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to delete domain' },
      { status: 500 }
    )
  }
})
