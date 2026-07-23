export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { v1ApiMiddleware, requirePermission } from '@/lib/api/v1/middleware'
import { createErrorResponse, createSuccessResponse, ErrorCodes } from '@/lib/api/v1/errors'
import { updateCartItem, removeFromCart, cartWithTotals, resolveSessionId } from '@/lib/services/cart-store'

/**
 * PATCH /v1/{projectId}/cart/items/:productId
 * Update the quantity of a specific cart item.
 * Body: { quantity: number }  — set to 0 or less to remove the item.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { projectId: string; productId: string } }
) {
  try {
    const middleware = await v1ApiMiddleware(request, params)
    if (middleware.response) return middleware.response
    const { context } = middleware

    const permissionCheck = requirePermission(context, ['write', 'admin'])
    if (permissionCheck) return permissionCheck

    let body: any
    try { body = await request.json() } catch {
      return createErrorResponse(ErrorCodes.BAD_REQUEST, 'Invalid JSON body', 400)
    }

    const quantity = parseInt(String(body?.quantity ?? ''), 10)
    if (isNaN(quantity)) {
      return createErrorResponse(ErrorCodes.BAD_REQUEST, 'quantity must be a number', 400)
    }

    const sessionId = resolveSessionId(request, context.apiKey.id)
    const cart = updateCartItem(context.projectId, sessionId, params.productId, quantity)

    if (!cart) {
      return createErrorResponse(ErrorCodes.NOT_FOUND, `Item ${params.productId} not found in cart`, 404)
    }

    return createSuccessResponse(cartWithTotals(cart))
  } catch (err: any) {
    console.error('[cart/items/:productId PATCH]', err?.message)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, 'Failed to update cart item', 500)
  }
}

/**
 * DELETE /v1/{projectId}/cart/items/:productId
 * Remove a specific item from the cart entirely.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { projectId: string; productId: string } }
) {
  try {
    const middleware = await v1ApiMiddleware(request, params)
    if (middleware.response) return middleware.response
    const { context } = middleware

    const permissionCheck = requirePermission(context, ['write', 'admin'])
    if (permissionCheck) return permissionCheck

    const sessionId = resolveSessionId(request, context.apiKey.id)
    const cart = removeFromCart(context.projectId, sessionId, params.productId)

    return createSuccessResponse(cartWithTotals(cart))
  } catch (err: any) {
    console.error('[cart/items/:productId DELETE]', err?.message)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, 'Failed to remove cart item', 500)
  }
}
