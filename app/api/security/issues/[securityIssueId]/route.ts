export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createTenantPrisma } from '@/lib/tenant/prisma'
import { withTenantIsolation, TenantIsolationError } from '@/lib/tenant/isolation'
import { authenticateRequest } from '@/lib/auth/middleware'
import { z } from 'zod'

const updateSchema = z.object({
  fixed: z.boolean().optional(),
})

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    return await withTenantIsolation(request, async (projectId) => {
      const auth = await authenticateRequest(request)
      if (!auth.authenticated || !auth.userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const tenantPrisma = createTenantPrisma(projectId)
      const body = await request.json()
      const data = updateSchema.parse(body)

      // TenantPrisma.update automatically validates ownership
      const issue = await tenantPrisma.securityIssue.update({
        where: { id: params.id },
        data: {
          fixed: data.fixed,
          fixedAt: data.fixed ? new Date() : null,
          fixedBy: data.fixed ? auth.userId : null,
        },
      })

      return NextResponse.json(issue)
    })
  } catch (error: any) {
    if (error instanceof TenantIsolationError) {
      return NextResponse.json(
        { error: error.message },
        { status: 403 }
      )
    }
    console.error('Error updating security issue:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to update security issue' },
      { status: 500 }
    )
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    return await withTenantIsolation(request, async (projectId) => {
      const tenantPrisma = createTenantPrisma(projectId)

      // TenantPrisma.delete automatically validates ownership
      await tenantPrisma.securityIssue.delete({
        where: { id: params.id },
      })

      return NextResponse.json({ success: true })
    })
  } catch (error: any) {
    if (error instanceof TenantIsolationError) {
      return NextResponse.json(
        { error: error.message },
        { status: 403 }
      )
    }
    console.error('Error deleting security issue:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to delete security issue' },
      { status: 500 }
    )
  }
}

