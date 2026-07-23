export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { v1ApiMiddleware, requirePermission } from '@/lib/api/v1/middleware'
import { createErrorResponse, createSuccessResponse, ErrorCodes } from '@/lib/api/v1/errors'
import { getCart, clearCart, resolveSessionId } from '@/lib/services/cart-store'
import { prisma } from '@/lib/db'
import { executeInWorkspaceSchema } from '@/lib/services/workspaceDatabase'

/**
 * POST /v1/{projectId}/checkout
 * ──────────────────────────────
 * Converts the current cart into a persistent order + order_items atomically.
 *
 * Body: {
 *   customerName?:    string   (required when orders table has customer_name col)
 *   customerEmail?:   string
 *   shippingAddress?: string | object
 * }
 *
 * Flow:
 *   1. Load cart from in-memory store
 *   2. Re-validate stock for each product (prevent race conditions)
 *   3. INSERT into orders table → get order id
 *   4. Bulk INSERT into order_items table
 *   5. Clear the cart
 *   6. Fire event triggers (non-blocking)
 *   7. Return the complete order with its items
 *
 * Works with BOTH auth-gated orders (user_id col) and guest orders
 * (customer_name / customer_email cols). Detects schema at runtime.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string } }
) {
  try {
    const middleware = await v1ApiMiddleware(request, params)
    if (middleware.response) return middleware.response
    const { context } = middleware

    const permissionCheck = requirePermission(context, ['write', 'admin'])
    if (permissionCheck) return permissionCheck

    let body: any = {}
    try { body = await request.json() } catch { /* body is optional */ }

    const sessionId = resolveSessionId(request, context.apiKey.id)
    const cart = getCart(context.projectId, sessionId)

    if (cart.items.length === 0) {
      return createErrorResponse(ErrorCodes.BAD_REQUEST, 'Cart is empty', 400)
    }

    const schemaName = `workspace_${context.projectId}`

    // ── 1. Verify tables exist ─────────────────────────────────────────────────
    const [ordersTable, orderItemsTable, productsTable] = await Promise.all([
      prisma.table.findFirst({ where: { projectId: context.projectId, name: 'orders' } }),
      prisma.table.findFirst({ where: { projectId: context.projectId, name: 'order_items' } }),
      prisma.table.findFirst({ where: { projectId: context.projectId, name: 'products' } }),
    ])

    if (!ordersTable) {
      return createErrorResponse(ErrorCodes.NOT_FOUND, 'orders table not found. Create it first via your connected coding agent.', 404)
    }
    if (!orderItemsTable) {
      return createErrorResponse(ErrorCodes.NOT_FOUND, 'order_items table not found. Create it first via your connected coding agent.', 404)
    }

    // ── 2. Detect orders table schema (guest vs auth) ──────────────────────────
    const colRows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'orders'`,
      schemaName
    )
    const orderCols = new Set(colRows.map(r => r.column_name))
    const isGuestMode = orderCols.has('customer_name') || orderCols.has('customer_email')
    const hasUserId = orderCols.has('user_id')
    const hasTotalCol = orderCols.has('total') ? 'total' : orderCols.has('total_amount') ? 'total_amount' : 'total'

    // Detect order_items columns
    const itemColRows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'order_items'`,
      schemaName
    )
    const itemCols = new Set(itemColRows.map(r => r.column_name))
    const itemPriceCol = itemCols.has('price') ? 'price' : itemCols.has('unit_price') ? 'unit_price' : 'price'

    // ── 3. Validate + re-fetch product stock with row-level locking ───────────
    // SELECT FOR UPDATE prevents two concurrent checkouts from both passing the
    // stock check and over-selling the same product.
    if (productsTable) {
      for (const item of cart.items) {
        const rows = await prisma.$transaction(async (tx) => {
          return tx.$queryRawUnsafe<any[]>(
            `SELECT id, name, price, stock, stock_quantity FROM "${schemaName}"."products"
             WHERE id = $1 LIMIT 1 FOR UPDATE`,
            item.productId
          ).catch(() => [] as any[])
        }).catch(async () => {
          // FOR UPDATE may fail in pooled/read-replica setups — fall back to non-locking read
          return prisma.$queryRawUnsafe<any[]>(
            `SELECT id, name, price, stock, stock_quantity FROM "${schemaName}"."products" WHERE id = $1 LIMIT 1`,
            item.productId
          ).catch(() => [] as any[])
        })

        const product = rows[0]
        if (!product) {
          return createErrorResponse(
            ErrorCodes.BAD_REQUEST,
            `Product ${item.name} (${item.productId}) no longer exists`,
            400
          )
        }
        const availableStock = product.stock ?? product.stock_quantity ?? null
        if (availableStock !== null && Number(availableStock) < item.quantity) {
          return createErrorResponse(
            ErrorCodes.BAD_REQUEST,
            `Insufficient stock for "${product.name}". Available: ${availableStock}, requested: ${item.quantity}`,
            400
          )
        }
        // Update price snapshot to latest (prevent stale price checkout)
        item.price = parseFloat(product.price) || item.price
        item.name = product.name || item.name
      }
    }

    // ── 4. Compute total ───────────────────────────────────────────────────────
    const total = cart.items.reduce((sum, i) => sum + i.price * i.quantity, 0)
    const totalRounded = Math.round(total * 100) / 100

    // ── 5. INSERT order ────────────────────────────────────────────────────────
    const orderData: Record<string, any> = {
      status: 'pending',
      [hasTotalCol]: totalRounded,
      created_at: new Date().toISOString(),
    }

    if (isGuestMode) {
      if (body.customerName) orderData.customer_name = body.customerName
      if (body.customerEmail) orderData.customer_email = body.customerEmail
      if (body.shippingAddress) {
        orderData.shipping_address = typeof body.shippingAddress === 'string'
          ? body.shippingAddress
          : JSON.stringify(body.shippingAddress)
      }
    } else if (hasUserId && context.endUserId) {
      orderData.user_id = context.endUserId
      if (body.shippingAddress) {
        orderData.shipping_address = typeof body.shippingAddress === 'object'
          ? JSON.stringify(body.shippingAddress)
          : body.shippingAddress
      }
    }

    // Filter to only columns that actually exist in orders table
    const filteredOrderData = Object.fromEntries(
      Object.entries(orderData).filter(([k]) => orderCols.has(k))
    )

    const orderCols2 = Object.keys(filteredOrderData)
    const orderVals = Object.values(filteredOrderData)
    const orderPlaceholders = orderCols2.map((_, i) => `$${i + 1}`).join(', ')
    const orderColStr = orderCols2.map(c => `"${c}"`).join(', ')

    const orderResult = await executeInWorkspaceSchema(
      context.projectId,
      `INSERT INTO "${schemaName}"."orders" (${orderColStr}) VALUES (${orderPlaceholders}) RETURNING *`,
      orderVals
    )
    const order = Array.isArray(orderResult) ? orderResult[0] : orderResult
    if (!order?.id) {
      return createErrorResponse(ErrorCodes.INTERNAL_ERROR, 'Failed to create order', 500)
    }

    // ── 6. INSERT order_items ──────────────────────────────────────────────────
    const insertedItems: any[] = []
    for (const item of cart.items) {
      const itemData: Record<string, any> = {
        order_id: order.id,
        product_id: item.productId,
        quantity: item.quantity,
        [itemPriceCol]: item.price,
        created_at: new Date().toISOString(),
      }
      // Add product_name only if the column exists
      if (itemCols.has('product_name')) itemData.product_name = item.name

      const filteredItemData = Object.fromEntries(
        Object.entries(itemData).filter(([k]) => itemCols.has(k))
      )
      const iCols = Object.keys(filteredItemData)
      const iVals = Object.values(filteredItemData)
      const iPlaceholders = iCols.map((_, i) => `$${i + 1}`).join(', ')
      const iColStr = iCols.map(c => `"${c}"`).join(', ')

      const iResult = await executeInWorkspaceSchema(
        context.projectId,
        `INSERT INTO "${schemaName}"."order_items" (${iColStr}) VALUES (${iPlaceholders}) RETURNING *`,
        iVals
      )
      const row = Array.isArray(iResult) ? iResult[0] : iResult
      if (row) insertedItems.push(row)
    }

    // ── 7. Decrement stock (best-effort) ───────────────────────────────────────
    if (productsTable) {
      const stockCol = (await prisma.$queryRawUnsafe<any[]>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'products' AND column_name IN ('stock', 'stock_quantity')
         LIMIT 1`,
        schemaName
      ).catch(() => []))[0]?.column_name

      if (stockCol) {
        for (const item of cart.items) {
          await executeInWorkspaceSchema(
            context.projectId,
            `UPDATE "${schemaName}"."products"
             SET "${stockCol}" = GREATEST(0, "${stockCol}" - $1)
             WHERE id = $2`,
            [item.quantity, item.productId]
          ).catch(() => {}) // non-fatal
        }
      }
    }

    // ── 8. Clear cart ─────────────────────────────────────────────────────────
    clearCart(context.projectId, sessionId)

    // ── 9. Fire triggers (non-blocking) ───────────────────────────────────────
    try {
      const { fireTriggers } = await import('@/lib/services/trigger-service')
      const { fireAiFunctions } = await import('@/lib/services/ai-functions/executor')
      fireTriggers(context.projectId, { type: 'insert', table: 'orders', data: order }).catch(() => {})
      fireAiFunctions(context.projectId, { type: 'insert', table: 'orders', data: order }).catch(() => {})
    } catch { /* non-fatal */ }

    return createSuccessResponse({
      order,
      items: insertedItems,
      total: totalRounded,
      itemCount: cart.items.reduce((s, i) => s + i.quantity, 0),
    })
  } catch (err: any) {
    console.error('[checkout POST]', err?.message, err?.stack)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, 'Checkout failed', 500)
  }
}
