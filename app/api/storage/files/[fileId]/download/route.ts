export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { storageService } from '@/lib/services/storage'
import { authenticateRequest } from '@/lib/auth/middleware'
import { prisma } from '@/lib/db'
import crypto from 'crypto'

/**
 * GET /api/storage/files/{fileId}/download — stream the file bytes.
 *
 * This is the single canonical download URL. Every URL generator in the
 * codebase (storageService.listFiles / getFileUrl / uploadFile) emits exactly
 * this shape, and AI-issued signed URLs point here too.
 *
 * Access rules:
 *   • public file        → anyone, no auth
 *   • private + ?token=  → HMAC signed URL (no login needed)
 *   • private, no token  → authenticated platform user who owns the project
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { fileId: string } }
) {
  try {
    const fileId = params.fileId
    const token = request.nextUrl.searchParams.get('token')

    // The file id is globally unique, so the owning project comes from the
    // row itself — no project header required for a public/signed download.
    const record = await prisma.storageFile.findUnique({
      where: { id: fileId },
      select: {
        projectId: true,
        isPublic: true,
        deletedAt: true,
        bucket: { select: { accessPolicy: true } },
      },
    })

    if (!record || record.deletedAt) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }

    // ── Access control for private files ─────────────────────────────────────
    if (!record.isPublic) {
      if (token) {
        // Validate the HMAC signed URL (format: "<expires>:<hmac>").
        const secret = process.env.STORAGE_SECRET
        if (!secret) {
          console.error('[storage/download] STORAGE_SECRET is not set')
          return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 })
        }
        const [expiresStr, hash] = token.split(':')
        const expires = parseInt(expiresStr, 10)
        if (!expires || Date.now() > expires) {
          return NextResponse.json({ error: 'Link expired' }, { status: 401 })
        }
        const expected = crypto
          .createHmac('sha256', secret)
          .update(`${fileId}:${expires}`)
          .digest('hex')
        if (
          !hash ||
          hash.length !== expected.length ||
          !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expected))
        ) {
          return NextResponse.json({ error: 'Invalid link' }, { status: 401 })
        }
      } else {
        // No token → must be the authenticated owner of the project.
        const auth = await authenticateRequest(request)
        if (!auth.authenticated || !auth.userId) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        const owns = await prisma.project.findFirst({
          where: { id: record.projectId, userId: auth.userId },
          select: { id: true },
        })
        if (!owns) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }
      }
    }

    const file = await storageService.getFile(fileId, record.projectId)
    if (!file) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }

    // Cache-Control by bucket access policy (#76).
    const CACHE_CONTROL: Record<string, string> = {
      public_read:   'public, max-age=31536000, immutable',
      cdn_cacheable: 'public, max-age=86400, stale-while-revalidate=604800',
      private:       'private, no-store',
      owner_only:    'private, no-store',
    }
    const cacheControl =
      CACHE_CONTROL[record.bucket?.accessPolicy ?? ''] ??
      (record.isPublic ? 'public, max-age=3600' : 'private, no-store')

    return new NextResponse(Buffer.from(file.buffer), {
      headers: {
        'Content-Type': file.mimeType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(file.name)}"`,
        'Content-Length': file.buffer.length.toString(),
        'Cache-Control': cacheControl,
      },
    })
  } catch (error: any) {
    console.error('[storage/download] failed:', error)
    return NextResponse.json(
      { error: error?.message || 'Failed to download file' },
      { status: 500 }
    )
  }
}
