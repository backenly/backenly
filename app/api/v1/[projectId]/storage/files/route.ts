export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { v1ApiMiddleware, requirePermission, requireCapability } from '@/lib/api/v1/middleware'
import { createErrorResponse, createSuccessResponse, ErrorCodes } from '@/lib/api/v1/errors'
import { listFilesSchema, paginationSchema } from '@/lib/api/v1/schemas'
import { validateQueryParams } from '@/lib/validation/schemas'
import { storageService } from '@/lib/services/storage'
import { prisma } from '@/lib/db'
import { recordedV1 } from '@/lib/traffic/recorded-v1'

/**
 * GET /v1/{projectId}/storage/files
 * List files in storage bucket
 */
async function handleGET(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  try {
    const middleware = await v1ApiMiddleware(request, params)
    if (middleware.response) {
      return middleware.response
    }

    const { context } = middleware

    const permissionCheck = requirePermission(context, ['read', 'admin'])
    if (permissionCheck) {
      return permissionCheck
    }

    const capabilityCheck = requireCapability(context, request.nextUrl.pathname)
    if (capabilityCheck) {
      return capabilityCheck
    }

    const searchParams = request.nextUrl.searchParams
    const bucket = searchParams.get('bucket')
    const prefix = searchParams.get('prefix') || undefined
    const limit = parseInt(searchParams.get('limit') || '100', 10)
    const offset = parseInt(searchParams.get('offset') || '0', 10)

    if (!bucket) {
      return createErrorResponse(
        ErrorCodes.BAD_REQUEST,
        'Bucket parameter is required',
        400
      )
    }

    // Validate bucket exists
    const bucketRecord = await prisma.storageBucket.findFirst({
      where: {
        projectId: context.projectId,
        name: bucket,
      },
    })

    if (!bucketRecord) {
      return createErrorResponse(
        ErrorCodes.NOT_FOUND,
        `Bucket '${bucket}' not found in this project`,
        404
      )
    }

    // List files
    const files = await storageService.listFiles(
      bucketRecord.id,
      context.projectId,
      {
        limit,
        offset,
        search: prefix,
      }
    )

    // Per-row policy, with the one decision function every serving path is
    // supposed to call. This listing used to return EVERY file in a private or
    // owner_only bucket to any read key — carrying a working signed URL per
    // row — so "private" governed the download route while the list route
    // handed out both the names and the links.
    const { mayRead } = await import('@/lib/storage/access-policy')
    const reader = context.endUserId
      ? { kind: 'endUser' as const, userId: context.endUserId }
      : context.apiKey.serviceRole || context.apiKey.role === 'admin'
        ? { kind: 'operator' as const, userId: context.apiKey.userId }
        : { kind: 'anonymous' as const }
    const visible = files.filter((file) =>
      mayRead(
        { bucketPolicy: bucketRecord.accessPolicy, fileIsPublic: file.isPublic, uploadedBy: file.uploadedBy },
        reader
      ).allowed
    )

    return createSuccessResponse(
      visible.map(file => ({
        id: file.id,
        name: file.name,
        // A working link is embedded only when the object is publicly readable
        // anyway. A reader allowed by ownership mints a link through the
        // download / signed-url endpoints, which re-check the policy.
        url: mayRead(
          { bucketPolicy: bucketRecord.accessPolicy, fileIsPublic: file.isPublic, uploadedBy: file.uploadedBy },
          { kind: 'anonymous' }
        ).allowed
          ? file.url
          : null,
        size: Number(file.size),
        contentType: file.mimeType,
        isPublic: file.isPublic,
        bucket: file.bucket,
        createdAt: file.createdAt,
      })),
      {
        limit,
        page: Math.floor(offset / limit),
        total: files.length,
        hasMore: files.length === limit,
      }
    )
  } catch (error: any) {
    console.error('Storage list files error:', error)
    return createErrorResponse(
      ErrorCodes.INTERNAL_ERROR,
      'Failed to list files',
      500
    )
  }
}

export const GET = recordedV1(handleGET)
