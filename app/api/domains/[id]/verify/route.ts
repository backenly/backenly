export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { verifyDomain } from '@/lib/domains'
import { enforceCustomDomain } from '@/lib/entitlements/policy'
import { prisma } from '@/lib/db/prisma'

/**
 * POST /api/domains/[id]/verify
 * Verify domain ownership via DNS TXT record
 * 🔒 Protected: Requires authentication + domain ownership
 */
export const POST = withAuth(async (request: NextRequest, { user, params }) => {
  try {
    const { id: domainId } = await params

    // Check if user owns the domain
    const domain = await prisma.customDomain.findFirst({
      where: {
        id: domainId,
        project: {
          userId: user.userId
        }
      }
    })

    if (!domain) {
      return NextResponse.json({ error: 'Domain not found' }, { status: 404 })
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

    // Attempt verification
    const result = await verifyDomain(domainId)

    return NextResponse.json({
      verified: result.verified,
      message: result.message,
      dnsRecord: result.dnsRecord || {
        type: 'TXT',
        name: domain.domain,
        value: domain.dnsRecordValue
      }
    })

  } catch (error: any) {
    console.error('[Domain Verify POST] Error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to verify domain' },
      { status: 500 }
    )
  }
})
