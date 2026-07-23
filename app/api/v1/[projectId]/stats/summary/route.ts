export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { v1ApiMiddleware, requirePermission } from '@/lib/api/v1/middleware'
import { createErrorResponse, createSuccessResponse, ErrorCodes } from '@/lib/api/v1/errors'
import { prisma } from '@/lib/db'

/**
 * GET /v1/{projectId}/stats/summary
 * ───────────────────────────────────
 * Returns aggregated backend statistics for the project dashboard.
 * All fields are auto-discovered from the actual workspace schema —
 * no hardcoded table names required.
 *
 * Response shape (all fields optional, present only if relevant table exists):
 * {
 *   totalProducts:     number | null,
 *   totalOrders:       number | null,
 *   totalRevenue:      number | null,   // SUM of total/total_amount on orders
 *   pendingOrders:     number | null,
 *   lowStockProducts:  number | null,   // stock/stock_quantity < lowStockThreshold
 *   recentOrders:      object[],        // last 5 orders newest-first
 * }
 *
 * Query params:
 *   ?lowStockThreshold=10   (default: 10)
 *   ?recentLimit=5          (default: 5, max 20)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { projectId: string } }
) {
  try {
    const middleware = await v1ApiMiddleware(request, params)
    if (middleware.response) return middleware.response
    const { context } = middleware

    const permissionCheck = requirePermission(context, ['read', 'admin'])
    if (permissionCheck) return permissionCheck

    const schemaName = `workspace_${context.projectId}`
    const sp = request.nextUrl.searchParams
    const lowStockThreshold = Math.max(1, parseInt(sp.get('lowStockThreshold') ?? '10', 10) || 10)
    const recentLimit = Math.min(20, Math.max(1, parseInt(sp.get('recentLimit') ?? '5', 10) || 5))

    // Discover which tables exist for this project
    const tables = await prisma.table.findMany({
      where: { projectId: context.projectId },
      select: { name: true },
    })
    const tableNames = new Set(tables.map(t => t.name))

    const stats: Record<string, any> = {}

    // ── Products ────────────────────────────────────────────────────────────────
    if (tableNames.has('products')) {
      // Detect the stock column name
      const stockColRows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'products'
           AND column_name IN ('stock', 'stock_quantity')
         LIMIT 1`,
        schemaName
      ).catch(() => [])
      const stockCol = stockColRows[0]?.column_name ?? null

      const productRows = await prisma.$queryRawUnsafe<Array<{ total: string; low_stock: string }>>(
        stockCol
          ? `SELECT COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE "${stockCol}" < ${lowStockThreshold})::int AS low_stock
             FROM "${schemaName}"."products"`
          : `SELECT COUNT(*)::int AS total, 0::int AS low_stock FROM "${schemaName}"."products"`,
      ).catch(() => [])

      stats.totalProducts = parseInt(String(productRows[0]?.total ?? 0), 10)
      stats.lowStockProducts = parseInt(String(productRows[0]?.low_stock ?? 0), 10)
    } else {
      stats.totalProducts = null
      stats.lowStockProducts = null
    }

    // ── Orders ──────────────────────────────────────────────────────────────────
    if (tableNames.has('orders')) {
      // Detect total column name
      const totalColRows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'orders'
           AND column_name IN ('total', 'total_amount', 'amount')
         ORDER BY CASE column_name WHEN 'total' THEN 1 WHEN 'total_amount' THEN 2 ELSE 3 END
         LIMIT 1`,
        schemaName
      ).catch(() => [])
      const totalCol = totalColRows[0]?.column_name ?? null

      const orderSummaryRows = await prisma.$queryRawUnsafe<Array<{
        total_count: string
        pending_count: string
        revenue: string
      }>>(
        totalCol
          ? `SELECT
               COUNT(*)::int AS total_count,
               COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
               COALESCE(SUM("${totalCol}"), 0)::numeric AS revenue
             FROM "${schemaName}"."orders"`
          : `SELECT
               COUNT(*)::int AS total_count,
               COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
               0::numeric AS revenue
             FROM "${schemaName}"."orders"`,
      ).catch(() => [])

      stats.totalOrders = parseInt(String(orderSummaryRows[0]?.total_count ?? 0), 10)
      stats.pendingOrders = parseInt(String(orderSummaryRows[0]?.pending_count ?? 0), 10)
      stats.totalRevenue = parseFloat(String(orderSummaryRows[0]?.revenue ?? 0))

      // Recent orders
      const recentRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM "${schemaName}"."orders"
         ORDER BY created_at DESC NULLS LAST
         LIMIT ${recentLimit}`,
      ).catch(() => [])
      stats.recentOrders = recentRows
    } else {
      stats.totalOrders = null
      stats.pendingOrders = null
      stats.totalRevenue = null
      stats.recentOrders = []
    }

    return createSuccessResponse(stats)
  } catch (err: any) {
    console.error('[stats/summary GET]', err?.message)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, 'Failed to fetch stats', 500)
  }
}
