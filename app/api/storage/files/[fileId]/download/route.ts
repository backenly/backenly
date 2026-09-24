export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { storageService } from '@/lib/services/storage'
import { authenticateRequest } from '@/lib/auth/middleware'
import { prisma } from '@/lib/db'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { canAccessProject } from '@/lib/edition/guard'
import { resolveJwtSecret } from '@/lib/services/jwtSecretManager'
import { cacheControlFor, mayRead, type Reader } from '@/lib/storage/access-policy'
import { isStorageUnavailable } from '@/lib/storage/errors'
import {
  getProjectServingState,
  PAUSED_CODE,
  PAUSED_MESSAGE,
  pausedDetails,
} from '@/lib/projects/serving-state'

/**
 * GET /api/storage/files/{fileId}/download — stream the file bytes.
 *
 * This is the single canonical download URL. Every URL generator in the codebase
 * (storageService.listFiles / getFileUrl / uploadFile) emits exactly this shape,
 * and AI-issued signed URLs point here too.
 *
 * ── The bucket's policy decides, at request time ────────────────────────────
 *
 * This route used to gate on `record.isPublic` alone — the FILE's column, which
 * is written once at upload from whatever the bucket's policy was then. So an
 * operator who tightened a bucket from `public_read` to `private` got a success
 * response and every object already in it stayed world-readable. Verified
 * against this route: 200, with the bytes, after the change.
 *
 * The bucket's CURRENT policy is now read on every request and is a ceiling: a
 * file may be more restricted than its bucket, never less. `lib/storage/
 * access-policy.ts` holds the whole rule, so this handler classifies the caller
 * and asks, rather than re-deriving a decision that two paths could disagree
 * about.
 *
 * ── One caveat this route cannot fix, and does not pretend to ───────────────
 *
 * With the S3 driver and `STORAGE_S3_PUBLIC_URL` set, a public object's URL
 * points at the CDN, not here. Those reads never reach this code, so tightening
 * a bucket cannot revoke them until the CDN object or cache is purged. The
 * storage panel says so where an operator chooses the policy; stating it is the
 * honest option, since the alternative is a control that silently does not apply
 * to the one configuration that serves the most traffic.
 */
export async function GET(request: NextRequest, props: { params: Promise<{ fileId: string }> }) {
  const params = await props.params
  try {
    const fileId = params.fileId
    const token = request.nextUrl.searchParams.get('token')

    // The file id is globally unique, so the owning project comes from the row
    // itself — no project header required for a public or signed download.
    const record = await prisma.storageFile.findUnique({
      where: { id: fileId },
      select: {
        projectId: true,
        isPublic: true,
        uploadedBy: true,
        deletedAt: true,
        bucket: { select: { accessPolicy: true } },
      },
    })

    if (!record || record.deletedAt) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }

    const reader = await classifyReader(request, fileId, token, record.projectId)
    if (reader === 'invalid-token') {
      // A token that was presented and did not verify is a distinct answer from
      // no token at all: the caller believes they hold a grant and do not.
      return NextResponse.json({ error: 'Invalid or expired link' }, { status: 401 })
    }
    if (reader === 'misconfigured') {
      return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 })
    }

    // A paused project stops serving its files through this route to everyone
    // except its own members, who still need them to export their data. A
    // public object served straight from a CDN never reaches this code, so a
    // pause cannot stop that and nothing claims it does.
    if (reader.kind !== 'operator') {
      const serving = await getProjectServingState(record.projectId)
      if (serving.kind === 'paused') {
        return NextResponse.json(
          {
            error: { code: PAUSED_CODE, message: PAUSED_MESSAGE, details: pausedDetails(record.projectId, serving) },
          },
          { status: 503 },
        )
      }
    }

    const decision = mayRead(
      {
        bucketPolicy: record.bucket?.accessPolicy,
        fileIsPublic: record.isPublic,
        uploadedBy: record.uploadedBy,
      },
      reader,
    )

    if (!decision.allowed) {
      // The reason is logged, not returned: an anonymous caller learning that a
      // bucket is `owner_only` rather than `private` is a small disclosure with
      // no upside for them.
      console.warn(`[storage/download] refused ${fileId}: ${decision.reason}`)
      return NextResponse.json(
        { error: decision.status === 401 ? 'Unauthorized' : 'Forbidden' },
        { status: decision.status },
      )
    }

    // `getFile` returns null ONLY for genuine absence, and throws
    // StorageUnavailableError when the bytes could not be read. Both used to
    // arrive here as null and leave as 404, so during a storage outage this
    // route told every caller their object had ceased to exist.
    const file = await storageService.getFile(fileId, record.projectId)
    if (!file) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }

    return new NextResponse(Buffer.from(file.buffer), {
      headers: {
        'Content-Type': file.mimeType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(file.name)}"`,
        'Content-Length': file.buffer.length.toString(),
        // Derived from the same policy the decision used, so a response can
        // never be cached publicly under a policy that did not permit public
        // reading. The old code chose this from the bucket policy while gating
        // access on the file column, which let a private bucket answer with
        // `public, max-age=31536000`.
        'Cache-Control': cacheControlFor(record.bucket?.accessPolicy, record.isPublic),
      },
    })
  } catch (error: any) {
    if (isStorageUnavailable(error)) {
      // 503, and RETRYABLE. The object exists; this deployment cannot reach its
      // bytes right now. A client that receives 404 prunes its copy and stops
      // asking, which is an irreversible reaction to a transient fault.
      console.error('[storage/download] storage unavailable:', error.cause ?? error.message)
      return NextResponse.json(
        { error: 'Storage unavailable', code: error.code },
        { status: 503, headers: { 'Retry-After': '30' } },
      )
    }
    console.error('[storage/download] failed:', error)
    return NextResponse.json(
      { error: error?.message || 'Failed to download file' },
      { status: 500 },
    )
  }
}

/**
 * Work out who is asking.
 *
 * Order matters. A signed link is checked first because it is scoped to one
 * object and needs no session. Then a platform session, which makes the caller
 * an operator if they can access the project. Then a project end-user token,
 * which is a DIFFERENT identity system: end users live in the project's own
 * users table and their tokens are signed with the project's secret. Treating
 * one as the other is the conflation the architecture forbids.
 */
async function classifyReader(
  request: NextRequest,
  fileId: string,
  token: string | null,
  projectId: string,
): Promise<Reader | 'invalid-token' | 'misconfigured'> {
  if (token) {
    const secret = process.env.STORAGE_SECRET
    if (!secret) {
      console.error('[storage/download] STORAGE_SECRET is not set')
      return 'misconfigured'
    }
    return verifySignedToken(fileId, token, secret) ? { kind: 'signed' } : 'invalid-token'
  }

  const auth = await authenticateRequest(request)
  if (auth.authenticated && auth.userId) {
    if (await canAccessProject(auth.userId, projectId)) {
      return { kind: 'operator', userId: auth.userId }
    }
    // A valid platform session for somebody with no access to this project.
    // Authentication is not authorization: they are identified, and refused
    // anything that is not public.
    return { kind: 'stranger', userId: auth.userId }
  }

  const endUser = await classifyEndUser(request, projectId)
  return endUser ?? { kind: 'anonymous' }
}

/** Constant-time check of the `<expires>:<hmac>` signed-link format. */
function verifySignedToken(fileId: string, token: string, secret: string): boolean {
  const [expiresStr, hash] = token.split(':')
  const expires = parseInt(expiresStr, 10)
  if (!expires || Date.now() > expires) return false

  const expected = crypto.createHmac('sha256', secret).update(`${fileId}:${expires}`).digest('hex')
  if (!hash || hash.length !== expected.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expected))
  } catch {
    return false
  }
}

/**
 * An end user of THIS project, from a bearer token signed with the project's own
 * secret.
 *
 * Only consulted for the project that owns the object, so a token minted by one
 * project can never identify a reader of another project's storage.
 */
async function classifyEndUser(request: NextRequest, projectId: string): Promise<Reader | null> {
  const header = request.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) return null
  const raw = header.slice(7).trim()
  if (!raw) return null

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { jwtSecret: true },
  })
  if (!project?.jwtSecret || project.jwtSecret.length < 32) return null

  try {
    const payload = jwt.verify(raw, resolveJwtSecret(project.jwtSecret)) as Record<string, unknown>
    // The token must name THIS project. A valid token for another project of the
    // same deployment is not an identity here.
    if (payload.projectId !== projectId) return null
    const userId = payload.userId
    if (typeof userId !== 'string' || !userId) return null
    return { kind: 'endUser', userId }
  } catch {
    return null
  }
}
