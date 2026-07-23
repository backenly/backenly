export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/actions
 *
 * Unified admin action dispatcher for the founder dashboard UI.
 * Uses JWT-only founder auth (no HMAC required) since this endpoint
 * is exclusively called from the first-party admin UI.
 *
 * Body: { action: string, ...params }
 *
 * Actions:
 *   suspend         { userId, suspend: bool, reason? }
 *   credits         { userId, creditAction: "reset"|"reduce", amount?, month? }
 *   repair-keys     {}
 *   sandbox-cleanup {}
 */

import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth/middleware'
import { prisma } from '@/lib/db/prisma'
import { cleanupExpiredSandboxes } from '@/lib/billing/sandbox'
import crypto from 'crypto'

async function requireFounderJwt(request: NextRequest): Promise<{ error: NextResponse } | { userId: string; email: string }> {
  const auth = await authenticateRequest(request)
  if (!auth.authenticated || !auth.userId || !auth.userEmail) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const founderEmail = process.env.FOUNDER_EMAIL
  const isFounder = founderEmail && auth.userEmail.toLowerCase() === founderEmail.toLowerCase()
  const isAdmin = auth.userRole === 'admin' || auth.userRole === 'super_admin'

  if (!isFounder && !isAdmin) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }

  return { userId: auth.userId, email: auth.userEmail }
}

export async function POST(request: NextRequest) {
  const authResult = await requireFounderJwt(request)
  if ('error' in authResult) return authResult.error

  let body: any = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { action } = body

  // ── Suspend / Unsuspend ───────────────────────────────────────────────────
  if (action === 'suspend') {
    const { userId, suspend, reason } = body
    if (!userId || typeof suspend !== 'boolean') {
      return NextResponse.json({ error: 'userId and suspend (boolean) are required' }, { status: 400 })
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, deletedAt: true, suspendedAt: true },
    })

    if (!user || user.deletedAt) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        suspendedAt: suspend ? new Date() : null,
        tokenVersion: { increment: 1 },
      },
      select: { id: true, email: true, suspendedAt: true },
    })

    await prisma.auditLog.create({
      data: {
        action: suspend ? 'USER_SUSPENDED' : 'USER_UNSUSPENDED',
        type: 'admin',
        userId,
        userEmail: user.email,
        details: reason ?? (suspend ? 'Suspended via admin dashboard' : 'Unsuspended via admin dashboard'),
      },
    })

    return NextResponse.json({
      success: true,
      userId,
      email: updated.email,
      suspended: !!updated.suspendedAt,
      suspendedAt: updated.suspendedAt,
    })
  }

  // ── Credits (reset / reduce) ──────────────────────────────────────────────
  if (action === 'credits') {
    const { userId, creditAction, amount, month } = body

    if (!userId || !['reset', 'reduce'].includes(creditAction)) {
      return NextResponse.json({ error: 'userId and creditAction (reset|reduce) are required' }, { status: 400 })
    }

    const targetMonth = month ?? new Date().toISOString().slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(targetMonth)) {
      return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 })
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, deletedAt: true },
    })
    if (!user || user.deletedAt) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const usageRecord = await prisma.userAiUsage.findFirst({
      where: { userId, date: targetMonth },
    })

    if (creditAction === 'reset') {
      if (usageRecord) {
        await prisma.userAiUsage.delete({ where: { id: usageRecord.id } })
      }
      await prisma.auditLog.create({
        data: {
          action: 'CREDITS_RESET',
          type: 'admin',
          userId,
          userEmail: user.email,
          details: `AI credits reset for ${targetMonth} via admin dashboard`,
        },
      })
      return NextResponse.json({ success: true, action: 'reset', month: targetMonth })
    }

    // reduce
    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return NextResponse.json({ error: 'amount (positive number) required for reduce' }, { status: 400 })
    }
    if (!usageRecord) {
      return NextResponse.json({ error: 'No usage record found for that month' }, { status: 404 })
    }

    const newCount = Math.max(0, usageRecord.intentCount - amount)
    await prisma.userAiUsage.update({
      where: { id: usageRecord.id },
      data: { intentCount: newCount },
    })

    await prisma.auditLog.create({
      data: {
        action: 'CREDITS_REFUNDED',
        type: 'admin',
        userId,
        userEmail: user.email,
        details: `Refunded ${amount} AI actions for ${targetMonth} (${usageRecord.intentCount} → ${newCount}) via admin dashboard`,
      },
    })

    return NextResponse.json({
      success: true,
      action: 'reduce',
      month: targetMonth,
      previousCount: usageRecord.intentCount,
      newCount,
      refunded: amount,
    })
  }

  // ── Repair API Keys ───────────────────────────────────────────────────────
  if (action === 'repair-keys') {
    const keysToRepair = await prisma.apiKey.findMany({
      where: { OR: [{ key: null }, { key: '' }] },
      select: { id: true, name: true, keyPrefix: true, projectId: true },
    })

    if (keysToRepair.length === 0) {
      return NextResponse.json({ success: true, message: 'No keys need repair', repaired: 0, keys: [] })
    }

    const repairedKeys: { id: string; name: string; projectId: string }[] = []

    for (const apiKey of keysToRepair) {
      const prefix = apiKey.keyPrefix || 'sk_live_'
      const randomBytes = crypto.randomBytes(32).toString('hex')
      const newFullKey = `${prefix}${randomBytes}`
      const newKeyHash = crypto.createHash('sha256').update(newFullKey).digest('hex')

      await prisma.apiKey.update({
        where: { id: apiKey.id },
        data: { key: newFullKey, keyHash: newKeyHash },
      })

      repairedKeys.push({ id: apiKey.id, name: apiKey.name, projectId: apiKey.projectId })
    }

    return NextResponse.json({
      success: true,
      message: `Repaired ${repairedKeys.length} API key(s)`,
      repaired: repairedKeys.length,
      keys: repairedKeys,
    })
  }

  // ── Sandbox Cleanup ───────────────────────────────────────────────────────
  if (action === 'sandbox-cleanup') {
    try {
      const start = Date.now()
      const result = await cleanupExpiredSandboxes()
      return NextResponse.json({
        success: true,
        deleted: result.deleted,
        errors: result.errors,
        durationMs: Date.now() - start,
        timestamp: new Date().toISOString(),
      })
    } catch (err: any) {
      return NextResponse.json({ error: err.message ?? 'Cleanup failed' }, { status: 500 })
    }
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
}
