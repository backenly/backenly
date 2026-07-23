export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { v1ApiMiddleware, requirePermission } from '@/lib/api/v1/middleware'
import { createErrorResponse, createSuccessResponse, ErrorCodes } from '@/lib/api/v1/errors'
import { getCart, cartWithTotals, clearCart, resolveSessionId } from '@/lib/services/cart-store'

/**
 * GET /v1/{projectId}/cart
 * Returns the current cart with items, subtotal, and item count.
 *
 * Session identity: X-Cart-Session header (or ?cartSession= query param).
 * If omitted the API key ID is used as the session key.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { projectId: string } }
) {
  try {
    const middleware = await v1ApiMiddleware(request, params)
    if (middleware.response) return middleware.response
    const { context } = middleware

    const permissionCheck = requirePermission(context, ['read', 'write', 'admin'])
    if (permissionCheck) return permissionCheck

    const sessionId = resolveSessionId(request, context.apiKey.id)
    const cart = getCart(context.projectId, sessionId)

    return createSuccessResponse(cartWithTotals(cart))
  } catch (err: any) {
    console.error('[cart GET]', err?.message)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, 'Failed to retrieve cart', 500)
  }
}

/**
 * DELETE /v1/{projectId}/cart
 * Alias for clear — empties the cart completely.
 * Also accessible at /cart/clear for backwards compatibility.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { projectId: string } }
) {
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
    console.error('[cart DELETE]', err?.message)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, 'Failed to clear cart', 500)
  }
}
