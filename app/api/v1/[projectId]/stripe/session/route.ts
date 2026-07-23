export const dynamic = 'force-dynamic'

/**
 * POST /v1/{projectId}/stripe/session
 * ────────────────────────────────────
 * Creates a Stripe Checkout Session from an existing pending order (or an
 * in-flight cart) and returns the hosted checkout URL.
 *
 * Body:
 *   orderId?      string   — existing order to pay for (recommended)
 *   successUrl    string   — where Stripe redirects after success
 *   cancelUrl     string   — where Stripe redirects on cancel
 *   currency?     string   — ISO 4217, default "usd"
 *   customerEmail? string  — pre-fills the Stripe checkout form
 *
 * Response:
 *   { sessionId, url, expiresAt }
 *
 * Stripe is called via its REST API (no SDK — avoids adding a heavyweight dep).
 * The project's Stripe secret key is retrieved from the encrypted key vault.
 */

import { NextRequest } from 'next/server'
import { v1ApiMiddleware, requirePermission } from '@/lib/api/v1/middleware'
import { createErrorResponse, createSuccessResponse, ErrorCodes } from '@/lib/api/v1/errors'
import { getIntegrationKey } from '@/lib/services/integrationKeyStore'
import { prisma } from '@/lib/db/prisma'
import { executeInWorkspaceSchema } from '@/lib/services/workspaceDatabase'

// ── Stripe REST helper ────────────────────────────────────────────────────────

async function stripePost(path: string, secretKey: string, body: Record<string, any>) {
  // Stripe API uses application/x-www-form-urlencoded
  const encoded = encodeStripeBody(body)

  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2023-10-16',
    },
    body: encoded,
  })

  const json = await res.json()
  if (!res.ok) {
    throw new Error(`Stripe API error ${res.status}: ${json?.error?.message ?? JSON.stringify(json)}`)
  }
  return json
}

/**
 * Recursively encode an object as Stripe's nested form format.
 * e.g. { line_items: [{ price_data: { ... } }] } →
 *      line_items[0][price_data][unit_amount]=...
 */
function encodeStripeBody(
  obj: Record<string, any>,
  prefix = '',
  out: string[] = [],
): string {
  for (const [key, val] of Object.entries(obj)) {
    const field = prefix ? `${prefix}[${key}]` : key
    if (val === null || val === undefined) continue
    if (typeof val === 'object' && !Array.isArray(val)) {
      encodeStripeBody(val, field, out)
    } else if (Array.isArray(val)) {
      val.forEach((item, i) => {
        if (typeof item === 'object' && item !== null) {
          encodeStripeBody(item, `${field}[${i}]`, out)
        } else {
          out.push(`${encodeURIComponent(`${field}[${i}]`)}=${encodeURIComponent(String(item))}`)
        }
      })
    } else {
      out.push(`${encodeURIComponent(field)}=${encodeURIComponent(String(val))}`)
    }
  }
  return out.join('&')
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string } },
) {
  try {
    const middleware = await v1ApiMiddleware(request, params)
    if (middleware.response) return middleware.response
    const { context } = middleware

    const permCheck = requirePermission(context, ['write', 'admin'])
    if (permCheck) return permCheck

    // ── 1. Parse body ─────────────────────────────────────────────────────────
    let body: {
      orderId?: string
      successUrl?: string
      cancelUrl?: string
      currency?: string
      customerEmail?: string
    } = {}
    try {
      body = await request.json()
    } catch {
      return createErrorResponse(ErrorCodes.BAD_REQUEST, 'Invalid JSON body', 400)
    }

    if (!body.successUrl || !body.cancelUrl) {
      return createErrorResponse(
        ErrorCodes.BAD_REQUEST,
        'successUrl and cancelUrl are required',
        400,
      )
    }

    // ── 2. Retrieve Stripe key ────────────────────────────────────────────────
    const stripeKey = await getIntegrationKey(context.projectId, 'stripe')
    if (!stripeKey) {
      return createErrorResponse(
        ErrorCodes.BAD_REQUEST,
        'Stripe is not connected. Connect your Stripe account via the integrations panel first.',
        400,
      )
    }

    // ── 3. Build line items ───────────────────────────────────────────────────
    const currency = (body.currency ?? 'usd').toLowerCase()
    const schemaName = `workspace_${context.projectId}`
    let lineItems: Array<{
      price_data: {
        currency: string
        unit_amount: number
        product_data: { name: string; description?: string }
      }
      quantity: number
    }> = []

    if (body.orderId) {
      // Load from existing order + order_items
      const orderRows = await executeInWorkspaceSchema(
        context.projectId,
        `SELECT * FROM "${schemaName}"."orders" WHERE id = $1 LIMIT 1`,
        [body.orderId],
      ).catch(() => [])

      const order = Array.isArray(orderRows) ? orderRows[0] : orderRows
      if (!order) {
        return createErrorResponse(ErrorCodes.NOT_FOUND, `Order ${body.orderId} not found`, 404)
      }

      // Try to load order items
      const itemRows = await executeInWorkspaceSchema(
        context.projectId,
        `SELECT oi.*, p.name as product_name, p.description as product_description
         FROM "${schemaName}"."order_items" oi
         LEFT JOIN "${schemaName}"."products" p ON oi.product_id = p.id
         WHERE oi.order_id = $1`,
        [body.orderId],
      ).catch(() => [])

      const items = Array.isArray(itemRows) ? itemRows : []

      if (items.length > 0) {
        lineItems = items.map((item: any) => ({
          price_data: {
            currency,
            unit_amount: Math.round((parseFloat(item.price ?? item.unit_price ?? 0)) * 100),
            product_data: {
              name: item.product_name ?? `Item #${item.product_id}`,
              description: item.product_description ?? undefined,
            },
          },
          quantity: item.quantity ?? 1,
        }))
      } else {
        // Fallback: single line item from order total
        const total = parseFloat(order.total ?? order.total_amount ?? 0)
        lineItems = [
          {
            price_data: {
              currency,
              unit_amount: Math.round(total * 100),
              product_data: { name: 'Order total' },
            },
            quantity: 1,
          },
        ]
      }
    } else {
      return createErrorResponse(
        ErrorCodes.BAD_REQUEST,
        'orderId is required. Create an order first via POST /v1/{projectId}/checkout, then call this endpoint with the returned order id.',
        400,
      )
    }

    // Filter out zero-value line items
    lineItems = lineItems.filter(li => li.price_data.unit_amount > 0)

    if (lineItems.length === 0) {
      return createErrorResponse(
        ErrorCodes.BAD_REQUEST,
        'Order has no billable items (all amounts are zero).',
        400,
      )
    }

    // ── 4. Create Stripe Checkout Session ─────────────────────────────────────
    const sessionPayload: Record<string, any> = {
      mode: 'payment',
      line_items: lineItems,
      success_url: body.successUrl,
      cancel_url: body.cancelUrl,
      metadata: {
        projectId: context.projectId,
        orderId: body.orderId ?? '',
      },
    }

    if (body.customerEmail) {
      sessionPayload.customer_email = body.customerEmail
    }

    // Honour end-user context when available
    if (context.endUserId) {
      sessionPayload.metadata.endUserId = context.endUserId
    }

    const session = await stripePost('/checkout/sessions', stripeKey, sessionPayload)

    // ── 5. Stamp the order with stripe_session_id (best-effort) ──────────────
    if (body.orderId) {
      const colCheck = await prisma.$queryRawUnsafe<any[]>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'orders' AND column_name = 'stripe_session_id'`,
        schemaName,
      ).catch(() => [])

      if (colCheck.length > 0) {
        await executeInWorkspaceSchema(
          context.projectId,
          `UPDATE "${schemaName}"."orders"
           SET stripe_session_id = $1, status = 'awaiting_payment'
           WHERE id = $2`,
          [session.id, body.orderId],
        ).catch(() => {})
      }
    }

    return createSuccessResponse({
      sessionId: session.id,
      url: session.url,
      expiresAt: new Date(session.expires_at * 1000).toISOString(),
    })
  } catch (err: any) {
    console.error('[stripe/session POST]', err?.message)

    // Surface Stripe errors cleanly
    if (err?.message?.includes('Stripe API error')) {
      return createErrorResponse(ErrorCodes.BAD_REQUEST, err.message, 400)
    }

    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, 'Failed to create Stripe session', 500)
  }
}
