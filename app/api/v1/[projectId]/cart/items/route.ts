export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { v1ApiMiddleware, requirePermission } from '@/lib/api/v1/middleware'
import { createErrorResponse, createSuccessResponse, ErrorCodes } from '@/lib/api/v1/errors'
import { addToCart, cartWithTotals, resolveSessionId } from '@/lib/services/cart-store'
import { prisma } from '@/lib/db'
import { executeWithUserContext } from '@/lib/services/workspace-rls'

/**
 * POST /v1/{projectId}/cart/items
 * Add an item to the cart.
 *
 * Body: { productId: string, quantity: number }
 *
 * Validates productId against the workspace products table and snapshots
 * the current price + name so cart totals survive price changes.
 */
export async function POST(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  try {
    const middleware = await v1ApiMiddleware(request, params)
    if (middleware.response) return middleware.response
    const { context } = middleware

    const permissionCheck = requirePermission(context, ['write', 'admin'])
    if (permissionCheck) return permissionCheck

    let body: any
    try {
      body = await request.json()
    } catch {
      return createErrorResponse(ErrorCodes.BAD_REQUEST, 'Invalid JSON body', 400)
    }

    const { productId, quantity } = body ?? {}

    if (!productId || typeof productId !== 'string') {
      return createErrorResponse(ErrorCodes.BAD_REQUEST, 'productId is required', 400)
    }
    const qty = parseInt(String(quantity ?? 1), 10)
    if (isNaN(qty) || qty < 1) {
      return createErrorResponse(ErrorCodes.BAD_REQUEST, 'quantity must be a positive integer', 400)
    }

    // Resolve the products table name for this project (support "products" table)
    const schemaName = `workspace_${context.projectId}`
    const productTable = await prisma.table.findFirst({
      where: { projectId: context.projectId, name: 'products' },
    })
    if (!productTable) {
      return createErrorResponse(ErrorCodes.NOT_FOUND, 'Products table not found in this project', 404)
    }

    // Fetch product to snapshot price + name
    const rows = await executeWithUserContext<any>(
      '', // bypass RLS for product lookup (public read)
      true,
      `SELECT id, name, price, stock FROM "${schemaName}"."products" WHERE id = $1 LIMIT 1`,
      [productId]
    )
    const product = rows[0]
    if (!product) {
      return createErrorResponse(ErrorCodes.NOT_FOUND, `Product ${productId} not found`, 404)
    }

    const stockVal = product.stock ?? product.stock_quantity ?? null
    if (stockVal !== null && Number(stockVal) < qty) {
      return createErrorResponse(ErrorCodes.BAD_REQUEST, `Insufficient stock. Available: ${stockVal}`, 400)
    }

    const sessionId = resolveSessionId(request, context.apiKey.id)
    const cart = addToCart(context.projectId, sessionId, {
      productId,
      quantity: qty,
      price: parseFloat(product.price) || 0,
      name: product.name || String(productId),
    })

    return createSuccessResponse(cartWithTotals(cart), { total: cart.items.length })
  } catch (err: any) {
    console.error('[cart/items POST]', err?.message)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, 'Failed to add item to cart', 500)
  }
}
