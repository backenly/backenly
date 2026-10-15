export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { v1ApiMiddleware, requirePermission, requireCapability } from '@/lib/api/v1/middleware'
import { createErrorResponse, createSuccessResponse, ErrorCodes } from '@/lib/api/v1/errors'
import { storageService } from '@/lib/services/storage'
import { prisma } from '@/lib/db'
import { isStorageUnavailable } from '@/lib/storage/errors'
import { recordedV1 } from '@/lib/traffic/recorded-v1'

/**
 * GET /v1/{projectId}/storage/files/{fileId}
 * Get file metadata
 */
async function handleGET(
  request: NextRequest,
  props: { params: Promise<{ projectId: string; fileId: string }> }
) {
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

    const file = await storageService.getFile(params.fileId, context.projectId)

    if (!file) {
      return createErrorResponse(
        ErrorCodes.NOT_FOUND,
        'File not found',
        404
      )
    }

    // The same per-object decision the download route makes. Without it, any
    // read key resolved any file id in a private or owner_only bucket to its
    // metadata and a working URL. Denied reads answer 404, not 403: a file id
    // must not become an existence oracle.
    {
      const { prisma } = await import('@/lib/db/prisma')
      const row = await prisma.storageFile.findFirst({
        where: { id: params.fileId, projectId: context.projectId },
        select: { isPublic: true, uploadedBy: true, bucket: { select: { accessPolicy: true } } },
      })
      const { mayRead } = await import('@/lib/storage/access-policy')
      const reader = context.endUserId
        ? { kind: 'endUser' as const, userId: context.endUserId }
        : context.apiKey.serviceRole || context.apiKey.role === 'admin'
          ? { kind: 'operator' as const, userId: context.apiKey.userId }
          : { kind: 'anonymous' as const }
      const decision = row
        ? mayRead({ bucketPolicy: row.bucket.accessPolicy, fileIsPublic: row.isPublic, uploadedBy: row.uploadedBy }, reader)
        : { allowed: false }
      if (!decision.allowed) {
        return createErrorResponse(ErrorCodes.NOT_FOUND, 'File not found', 404)
      }
    }

    // Get file URL
    const url = await storageService.getFileUrl(params.fileId, context.projectId)

    return createSuccessResponse({
      id: params.fileId,
      path: file.path,
      url,
      size: file.buffer.length,
      contentType: file.mimeType,
      name: file.name,
    })
  } catch (error: any) {
    if (isStorageUnavailable(error)) {
      // The file record exists; its bytes are unreachable. Reporting 404 here
      // would tell an API consumer the object had been deleted.
      console.error('Storage get file: storage unavailable:', error.cause ?? error.message)
      return createErrorResponse(
        ErrorCodes.SERVICE_UNAVAILABLE,
        'Storage is currently unavailable',
        503
      )
    }
    console.error('Storage get file error:', error)
    return createErrorResponse(
      ErrorCodes.INTERNAL_ERROR,
      'Failed to get file',
      500
    )
  }
}

/**
 * DELETE /v1/{projectId}/storage/files/{fileId}
 * Delete file
 */
async function handleDELETE(
  request: NextRequest,
  props: { params: Promise<{ projectId: string; fileId: string }> }
) {
  const params = await props.params;
  try {
    const middleware = await v1ApiMiddleware(request, params)
    if (middleware.response) {
      return middleware.response
    }

    const { context } = middleware

    const permissionCheck = requirePermission(context, ['write', 'admin'])
    if (permissionCheck) {
      return permissionCheck
    }

    const capabilityCheck = requireCapability(context, request.nextUrl.pathname)
    if (capabilityCheck) {
      return capabilityCheck
    }

    // Deleting is held to ownership or operator authority. 'write' permission
    // alone let any publishable key — "safe in a browser" — delete any file in
    // the project by id.
    {
      const { prisma } = await import('@/lib/db/prisma')
      const row = await prisma.storageFile.findFirst({
        where: { id: params.fileId, projectId: context.projectId, deletedAt: null },
        select: { uploadedBy: true },
      })
      if (!row) {
        return createErrorResponse(ErrorCodes.NOT_FOUND, 'File not found', 404)
      }
      const operatorGrade = context.apiKey.serviceRole || context.apiKey.role === 'admin'
      const isUploader = context.endUserId !== null && row.uploadedBy === context.endUserId
      if (!operatorGrade && !isUploader) {
        return createErrorResponse(
          ErrorCodes.FORBIDDEN,
          'Only the end user who uploaded this file, or a server-side service key, may delete it.',
          403
        )
      }
    }

    await storageService.deleteFile(params.fileId, context.projectId)

    return createSuccessResponse({
      deleted: true,
      id: params.fileId,
    })
  } catch (error: any) {
    console.error('Storage delete file error:', error)
    return createErrorResponse(
      ErrorCodes.INTERNAL_ERROR,
      'Failed to delete file',
      500
    )
  }
}

export const GET = recordedV1(handleGET)
export const DELETE = recordedV1(handleDELETE)
