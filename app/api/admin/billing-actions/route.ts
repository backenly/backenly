export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/billing-actions
 *
 * Founder revenue-ops actions:
 *   comp          { userId, planName }     — grant a paid plan for free (no Paddle)
 *   uncomp        { userId }               — revert a comped user to FREE
 *   extend_grace  { userId, days }         — push graceUntil out N days
 *   cancel        { userId }               — cancel the user's Paddle sub (SDK) + grace
 *   refund_link   { userId }               — returns the Paddle dashboard deep-link
 *                                            (refunds are issued in Paddle, not faked here)
 *
 * FOUNDER-ONLY. Every action writes an AuditLog row.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/auth/requireFounder'
import { authenticateRequest } from '@/lib/auth/middleware'
import { prisma } from '@/lib/db/prisma'

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

  // ── Uncomp: back to FREE ───────────────────────────────────────────────────
  if (action === 'uncomp') {
    const free = await prisma.plan.findUnique({ where: { name: 'FREE' } })
    const existing = await prisma.subscription.findFirst({ where: { userId } })
    if (existing && free) {
      await prisma.subscription.update({
        where: { id: existing.id },
        data: { planId: free.id, status: 'FREE', currentPeriodEnd: null, graceUntil: null },
      })
    }
    await prisma.user.update({ where: { id: userId }, data: { tier: 'free' } })
    await audit('BILLING_UNCOMP', `Reverted ${user.email} → FREE`, { userId })
    return NextResponse.json({ success: true, message: `${user.email} reverted to FREE` })
  }

  // ── Extend grace ───────────────────────────────────────────────────────────
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
      await paddle.subscriptions.cancel(sub.paddleSubscriptionId, { effectiveFrom: 'next_billing_period' })
      await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'GRACE' } })
      await audit('BILLING_CANCELED', `Admin-canceled Paddle sub for ${user.email} (effective next period)`, { userId, paddleSubscriptionId: sub.paddleSubscriptionId })
      return NextResponse.json({ success: true, message: `Cancellation scheduled for ${user.email} (next billing period)` })
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
