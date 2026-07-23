export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { storageService } from '@/lib/services/storage'
import { withTenantIsolation, TenantIsolationError } from '@/lib/tenant/isolation'
import { validateProjectOwnership } from '@/lib/tenant/isolation'
import { prisma } from '@/lib/db'
import { runMutation, mutationHttpStatus } from '@/lib/ai/build-runtime/mutate'

// GET /api/storage/buckets/[bucketId] — Get bucket info + stats
export async function GET(
  request: NextRequest,
  { params }: { params: { bucketId: string } }
) {
  try {
    return await withTenantIsolation(request, async (projectId) => {
      const bucket = await storageService.getBucket(params.bucketId, projectId)
      if (!bucket) {
        return NextResponse.json({ error: 'Bucket not found' }, { status: 404 })
      }

      const bucketRecord = await prisma.storageBucket.findUnique({
        where:  { id: params.bucketId },
        select: { projectId: true },
      })
      if (bucketRecord) {
        await validateProjectOwnership(projectId, bucketRecord.projectId, 'Bucket')
      }

      const stats = await storageService.getBucketStats(params.bucketId, projectId)
      return NextResponse.json({ bucket, stats })
    })
  } catch (error: any) {
    if (error instanceof TenantIsolationError) {
      return NextResponse.json({ error: error.message }, { status: 403 })
    }
    console.error('Failed to get bucket:', error)
    return NextResponse.json({ error: error.message || 'Failed to get bucket' }, { status: 500 })
  }
}

// DELETE /api/storage/buckets/[bucketId] — Delete bucket (GOVERNED)
//
// Goes through runMutation() to enforce:
//   budget → lock → snapshot → execute → audit → trace → UI sync → release
export async function DELETE(
  request: NextRequest,
  { params }: { params: { bucketId: string } }
) {
  try {
    return await withTenantIsolation(request, async (projectId) => {
      // Ownership check BEFORE acquiring lock (read-only, safe)
      const bucketRecord = await prisma.storageBucket.findUnique({
        where:  { id: params.bucketId },
        select: { projectId: true, name: true },
      })
      if (!bucketRecord) {
        return NextResponse.json({ error: 'Bucket not found' }, { status: 404 })
      }
      await validateProjectOwnership(projectId, bucketRecord.projectId, 'Bucket')

      // Governed deletion
      const result = await runMutation(
        {
          projectId,
          kind:           'storage',
          action:         `delete_bucket_${bucketRecord.name}`,
          auditAction:    'STORAGE_DELETE_BUCKET',
          snapshotBefore: false,  // storage bucket deletions don't need schema snapshots
        },
        () => storageService.deleteBucket(params.bucketId, projectId),
      )

      if (!result.ok) {
        return NextResponse.json(
          { error: result.error ?? 'Failed to delete bucket' },
          { status: mutationHttpStatus(result) },
        )
      }

      return NextResponse.json({ success: true })
    })
  } catch (error: any) {
    if (error instanceof TenantIsolationError) {
      return NextResponse.json({ error: error.message }, { status: 403 })
    }
    console.error('Failed to delete bucket:', error)
    return NextResponse.json({ error: error.message || 'Failed to delete bucket' }, { status: 500 })
  }
}

// PATCH /api/storage/buckets/[bucketId] — Update bucket security settings (GOVERNED)
export async function PATCH(
  request: NextRequest,
  { params }: { params: { bucketId: string } }
) {
  try {
    return await withTenantIsolation(request, async (projectId) => {
      const bucketRecord = await prisma.storageBucket.findUnique({
        where:  { id: params.bucketId },
        select: { projectId: true },
      })
      if (!bucketRecord) {
        return NextResponse.json({ error: 'Bucket not found' }, { status: 404 })
      }
      await validateProjectOwnership(projectId, bucketRecord.projectId, 'Bucket')

      const body = await request.json()
      const {
        allowedMimeTypes,
        allowedExtensions,
        blockExecutables,
        maxFileSizeBytes,
        overwriteStrategy,
        isPublic,
        accessPolicy,
      } = body

      const VALID_ACCESS_POLICIES = ['public_read', 'private', 'owner_only', 'cdn_cacheable']

      if (overwriteStrategy && !['auto_rename', 'version', 'deny', 'replace'].includes(overwriteStrategy)) {
        return NextResponse.json(
          { error: 'Invalid overwriteStrategy. Must be one of: auto_rename, version, deny, replace' },
          { status: 400 },
        )
      }
      if (accessPolicy && !VALID_ACCESS_POLICIES.includes(accessPolicy)) {
        return NextResponse.json(
          { error: `Invalid accessPolicy. Must be one of: ${VALID_ACCESS_POLICIES.join(', ')}` },
          { status: 400 },
        )
      }

      const derivedIsPublic =
        accessPolicy === 'public_read' || accessPolicy === 'cdn_cacheable' ? true
        : accessPolicy === 'private' || accessPolicy === 'owner_only'      ? false
        : isPublic

      // Governed update
      const result = await runMutation(
        {
          projectId,
          kind:        'storage',
          action:      'update_bucket_settings',
          auditAction: 'STORAGE_UPDATE_BUCKET',
        },
        async () => {
          return prisma.storageBucket.update({
            where: { id: params.bucketId },
            data: {
              ...(allowedMimeTypes   !== undefined && { allowedMimeTypes }),
              ...(allowedExtensions  !== undefined && { allowedExtensions }),
              ...(blockExecutables   !== undefined && { blockExecutables }),
              ...(maxFileSizeBytes   !== undefined && { maxFileSizeBytes: BigInt(maxFileSizeBytes) }),
              ...(overwriteStrategy  !== undefined && { overwriteStrategy }),
              ...(derivedIsPublic    !== undefined && { isPublic: derivedIsPublic }),
              ...(accessPolicy       !== undefined && { accessPolicy }),
            },
          })
        },
      )

      if (!result.ok) {
        return NextResponse.json(
          { error: result.error ?? 'Failed to update bucket' },
          { status: mutationHttpStatus(result) },
        )
      }

      const updatedBucket = result.data!
      return NextResponse.json({
        bucket: {
          id:               updatedBucket.id,
          name:             updatedBucket.name,
          isPublic:         updatedBucket.isPublic,
          accessPolicy:     updatedBucket.accessPolicy,
          allowedMimeTypes: updatedBucket.allowedMimeTypes,
          allowedExtensions:updatedBucket.allowedExtensions,
          blockExecutables: updatedBucket.blockExecutables,
          maxFileSizeBytes: updatedBucket.maxFileSizeBytes.toString(),
          overwriteStrategy:updatedBucket.overwriteStrategy,
        },
      })
    })
  } catch (error: any) {
    if (error instanceof TenantIsolationError) {
      return NextResponse.json({ error: error.message }, { status: 403 })
    }
    console.error('Failed to update bucket:', error)
    return NextResponse.json({ error: error.message || 'Failed to update bucket' }, { status: 500 })
  }
}
