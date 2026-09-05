export const dynamic = 'force-dynamic'

/**
 * Blocklist management for the founder admin Control tab.
 *
 * GET    /api/admin/blocklist                → list all entries
 * POST   /api/admin/blocklist                → add { kind, value, reason? }
 * DELETE /api/admin/blocklist?id=<entryId>   → remove an entry
 *
 * FOUNDER-ONLY. Cache invalidation is fired so guards pick the new state up
 * within ~10 s without any restart.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/admin/auth/requireFounder'
import { authenticateRequest } from '@/lib/auth/middleware'
import { prisma } from '@/lib/db/prisma'
import { invalidateBlocklistCache, recordSecurityEvent } from '@/lib/platform/controls'

const VALID_KINDS = ['ip', 'email', 'domain'] as const

export async function GET(request: NextRequest) {
  const authError = await requireFounder(request)
  if (authError) return authError
  const entries = await prisma.blocklist.findMany({ orderBy: { createdAt: 'desc' } })
  return NextResponse.json({ entries })
}

export async function POST(request: NextRequest) {
  const authError = await requireFounder(request)
  if (authError) return authError
  const auth = await authenticateRequest(request)
  if (!auth.authenticated || !auth.userId || !auth.userEmail) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: any = {}
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const kind = String(body.kind ?? '').toLowerCase().trim()
  const value = String(body.value ?? '').toLowerCase().trim()
  const reason = typeof body.reason === 'string' ? body.reason.trim() || null : null

  if (!VALID_KINDS.includes(kind as any)) {
    return NextResponse.json({ error: `kind must be one of: ${VALID_KINDS.join(', ')}` }, { status: 400 })
  }
  if (!value) {
    return NextResponse.json({ error: 'value is required' }, { status: 400 })
  }

  // Lightweight shape checks per kind — the goal is to keep the table from
  // accumulating garbage that never matches anything in production.
  if (kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return NextResponse.json({ error: 'value must look like an email' }, { status: 400 })
  }
  if (kind === 'domain' && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) {
    return NextResponse.json({ error: 'value must look like a domain (e.g. spambot.com)' }, { status: 400 })
  }
  if (kind === 'ip' && !/^[0-9.:a-fA-F]+(\/\d{1,3})?$/.test(value)) {
    return NextResponse.json({ error: 'value must look like an IP (CIDR optional)' }, { status: 400 })
  }

  const entry = await prisma.blocklist.upsert({
    where: { kind_value: { kind, value } },
    create: { kind, value, reason, createdBy: auth.userId },
    update: { reason, createdBy: auth.userId },
  })
  invalidateBlocklistCache()

  await prisma.auditLog.create({
    data: {
      action: 'BLOCKLIST_ADDED',
      type: 'admin',
      userId: auth.userId,
      userEmail: auth.userEmail,
      details: `Added ${kind}=${value}${reason ? ` (${reason})` : ''}`,
      metadata: { kind, value, reason } as object,
    },
  })
  await recordSecurityEvent({
    kind: 'blocklist_hit',
    severity: 'info',
    userId: auth.userId,
    userEmail: auth.userEmail,
    summary: `Blocklist entry added: ${kind}=${value}`,
    detail: { kind, value, reason, source: 'admin' },
  }).catch(() => {})

  return NextResponse.json({ entry })
}

export async function DELETE(request: NextRequest) {
  const authError = await requireFounder(request)
  if (authError) return authError
  const auth = await authenticateRequest(request)
  if (!auth.authenticated || !auth.userId || !auth.userEmail) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const id = request.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const existing = await prisma.blocklist.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await prisma.blocklist.delete({ where: { id } })
  invalidateBlocklistCache()

  await prisma.auditLog.create({
    data: {
      action: 'BLOCKLIST_REMOVED',
      type: 'admin',
      userId: auth.userId,
      userEmail: auth.userEmail,
      details: `Removed ${existing.kind}=${existing.value}`,
      metadata: { kind: existing.kind, value: existing.value } as object,
    },
  })

  return NextResponse.json({ success: true })
}
