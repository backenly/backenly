export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/billing-actions
 *
 * Founder revenue-ops actions:
 *   comp          { userId, planName }     — grant a paid plan for free (no Paddle)
 *   uncomp        { userId }               — revert a comped user to the free plan
 *   extend_grace  { userId, days }         — push graceUntil out N days (payment recovery)
 *   cancel        { userId }               — schedule Paddle cancellation at period end
 *   refund_link   { userId }               — returns the Paddle dashboard deep-link
 *                                            (refunds are issued in Paddle, not faked here)
 *
 * FOUNDER-ONLY. Every action writes an AuditLog row.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/admin/auth/requireFounder'
import { authenticateRequest } from '@/lib/auth/middleware'
import { prisma } from '@/lib/db/prisma'
import { resolveFreePlan } from '@/lib/billing'
import { recordScheduledCancellation } from '@/lib/billing/grace'

export async function POST(request: NextRequest) {
  const authError = await requireFounder(request)
  if (authError) return authError
  const auth = await authenticateRequest(request)
  if (!auth.authenticated || !auth.userId || !auth.userEmail) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const actor = { userId: auth.userId, userEmail: auth.userEmail }

  let body: any = {}
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const { action, userId } = body
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 })

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, tier: true, deletedAt: true },
  })
  if (!user || user.deletedAt) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const audit = (act: string, details: string, metadata?: object) =>
    prisma.auditLog.create({
      data: { action: act, type: 'admin', userId: actor.userId, userEmail: actor.userEmail, details, ...(metadata ? { metadata } : {}) },
    })

  // ── Comp: grant a paid plan for free ───────────────────────────────────────
  if (action === 'comp') {
    const planName = String(body.planName ?? '').toUpperCase()
    const plan = await prisma.plan.findUnique({ where: { name: planName } })
    if (!plan) {
      const all = await prisma.plan.findMany({ select: { name: true } })
      return NextResponse.json({ error: `Unknown plan. Valid: ${all.map(p => p.name).join(', ')}` }, { status: 400 })
    }
    const existing = await prisma.subscription.findFirst({ where: { userId } })
    if (existing) {
      await prisma.subscription.update({
        where: { id: existing.id },
        data: { planId: plan.id, status: 'ACTIVE', currentPeriodEnd: null, graceUntil: null },
      })
    } else {
      await prisma.subscription.create({
        data: { userId, planId: plan.id, status: 'ACTIVE' },
      })
    }
    await prisma.user.update({ where: { id: userId }, data: { tier: plan.name.toLowerCase() } })
    await audit('BILLING_COMP', `Comped ${user.email} → ${plan.name} (free, no Paddle)`, { userId, plan: plan.name })
    return NextResponse.json({ success: true, message: `${user.email} comped to ${plan.name}` })
  }

  // ── Uncomp: back to the free plan ──────────────────────────────────────────
  //
  // This looked up the plan named FREE, which prisma/seed-billing.ts does not
  // create. On a seeded install the lookup returned null, the subscription
  // update was skipped by the `&& free` guard, and the action still set
  // user.tier, wrote a success audit row and returned success — while the user
  // stayed ACTIVE on their comped paid plan. resolveFreePlan throws instead, so
  // a broken install fails visibly rather than reporting work it did not do.
  if (action === 'uncomp') {
    let free
    try {
      free = await resolveFreePlan()
    } catch (err: any) {
      return NextResponse.json({ error: err?.message ?? 'No free plan configured' }, { status: 500 })
    }

    const existing = await prisma.subscription.findFirst({ where: { userId } })
    if (!existing) {
      return NextResponse.json({ error: 'No subscription for user' }, { status: 404 })
    }

    await prisma.subscription.update({
      where: { id: existing.id },
      data: {
        planId: free.id,
        status: 'FREE',
        currentPeriodEnd: null,
        graceUntil: null,
        cancelScheduledAt: null,
      },
    })
    await prisma.user.update({ where: { id: userId }, data: { tier: 'free' } })
    await audit('BILLING_UNCOMP', `Reverted ${user.email} → ${free.name}`, { userId, plan: free.name })
    return NextResponse.json({ success: true, message: `${user.email} reverted to ${free.name}` })
  }

  // ── Extend grace ───────────────────────────────────────────────────────────
  // A deliberate manual payment-recovery override, unchanged: it is how a
  // founder gives a customer with a billing problem more time. It is not part
  // of the cancellation lifecycle and must not be used for one.
  if (action === 'extend_grace') {
    const days = Math.max(1, Math.min(90, Number(body.days) || 7))
    const sub = await prisma.subscription.findFirst({ where: { userId } })
    if (!sub) return NextResponse.json({ error: 'No subscription for user' }, { status: 404 })
    const base = sub.graceUntil && sub.graceUntil > new Date() ? sub.graceUntil : new Date()
    const graceUntil = new Date(base.getTime() + days * 86_400_000)
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { graceUntil, status: 'GRACE' },
    })
    await audit('BILLING_GRACE_EXTENDED', `Extended ${user.email} grace by ${days}d → ${graceUntil.toISOString().slice(0, 10)}`, { userId, days })
    return NextResponse.json({ success: true, message: `Grace extended ${days}d for ${user.email}` })
  }

  // ── Cancel the Paddle subscription ─────────────────────────────────────────
  if (action === 'cancel') {
    const sub = await prisma.subscription.findFirst({ where: { userId } })
    if (!sub?.paddleSubscriptionId) {
      return NextResponse.json({ error: 'No Paddle subscription on this user' }, { status: 400 })
    }
    if (!process.env.PADDLE_API_KEY) {
      return NextResponse.json({ error: 'Paddle not configured (PADDLE_API_KEY missing)' }, { status: 500 })
    }
    try {
      const { Paddle, Environment } = await import('@paddle/paddle-node-sdk')
      const paddle = new Paddle(process.env.PADDLE_API_KEY, {
        environment: process.env.PADDLE_ENVIRONMENT === 'production' ? Environment.production : Environment.sandbox,
      })
      const updated = await paddle.subscriptions.cancel(sub.paddleSubscriptionId, { effectiveFrom: 'next_billing_period' })

      // Same semantics as the customer-facing cancel: a scheduled cancellation
      // is not a failed payment, so the subscription stays ACTIVE and entitled
      // until the provider's terminal event. It used to be forced into GRACE,
      // which cut a paying customer's access short by however many days were
      // left in the period they had paid for.
      // Persisted only from an explicit provider scheduled cancellation, same
      // rule as the customer-facing route: never from a renewal date or the
      // stored period end. If Paddle did not state a date the cancellation is
      // still scheduled with them, and the subscription.updated webhook fills
      // it in.
      const scheduledChange = (updated as any)?.scheduledChange
      const parsed =
        scheduledChange?.action === 'cancel' && scheduledChange?.effectiveAt
          ? new Date(scheduledChange.effectiveAt)
          : null
      const effectiveAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null

      if (effectiveAt) {
        await recordScheduledCancellation(sub.paddleSubscriptionId, effectiveAt)
      }

      await audit('BILLING_CANCELED', `Admin-canceled Paddle sub for ${user.email} (effective next period)`, { userId, paddleSubscriptionId: sub.paddleSubscriptionId })
      return NextResponse.json({
        success: true,
        cancelScheduledAt: effectiveAt?.toISOString() ?? null,
        message: `Cancellation scheduled for ${user.email} (next billing period)`,
      })
    } catch (err: any) {
      return NextResponse.json({ error: `Paddle cancel failed: ${err?.message ?? 'unknown'}` }, { status: 502 })
    }
  }

  // ── Refund: surface the Paddle deep-link (refunds are issued in Paddle) ─────
  if (action === 'refund_link') {
    const sub = await prisma.subscription.findFirst({ where: { userId } })
    const env = process.env.PADDLE_ENVIRONMENT === 'production' ? 'vendors' : 'sandbox-vendors'
    const url = sub?.paddleSubscriptionId
      ? `https://${env}.paddle.com/subscriptions/${sub.paddleSubscriptionId}`
      : `https://${env}.paddle.com/`
    await audit('BILLING_REFUND_LINK_OPENED', `Founder opened Paddle refund console for ${user.email}`, { userId })
    return NextResponse.json({
      success: true,
      url,
      note: 'Refunds are issued from the Paddle dashboard, not via this API — opening the subscription there.',
    })
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
}
