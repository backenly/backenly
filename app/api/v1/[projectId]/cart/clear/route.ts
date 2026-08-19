export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { v1ApiMiddleware, requirePermission } from '@/lib/api/v1/middleware'
import { createErrorResponse, createSuccessResponse, ErrorCodes } from '@/lib/api/v1/errors'
import { clearCart, resolveSessionId } from '@/lib/services/cart-store'

/**
 * DELETE /v1/{projectId}/cart/clear
 * Empties the current cart session completely.
 */
export async function DELETE(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  try {
    const middleware = await v1ApiMiddleware(request, params)
    if (middleware.response) return middleware.response
    const { context } = middleware

    const permissionCheck = requirePermission(context, ['write', 'admin'])
    if (permissionCheck) return permissionCheck

    const sessionId = resolveSessionId(request, context.apiKey.id)
    clearCart(context.projectId, sessionId)

    return createSuccessResponse({ cleared: true, sessionId })
  } catch (err: any) {
    console.error('[cart/clear DELETE]', err?.message)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, 'Failed to clear cart', 500)
  }
}
