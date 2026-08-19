export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { v1ApiMiddleware, requirePermission, requireCapability } from '@/lib/api/v1/middleware'
import { createErrorResponse, createSuccessResponse, ErrorCodes } from '@/lib/api/v1/errors'
import { storageService } from '@/lib/services/storage'
import { prisma } from '@/lib/db'

/**
 * GET /v1/{projectId}/storage/files/{fileId}
 * Get file metadata
 */
export async function GET(
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
export async function DELETE(
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

