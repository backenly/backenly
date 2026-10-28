/**
 * Storage buckets in the change history (lib/changes/resources).
 *
 * A bucket's settings come back exactly. A bucket a change created goes again
 * only while it holds no files: files are what the application wrote, and a
 * restore never removes them. A bucket a change removed took its files with it
 * (lib/services/storage.ts deleteBucket), so only an empty one comes back.
 */

import { prisma } from '@/lib/db/prisma'
import type { Irreversible, ResourceAdapter, ResourceItem, ResourceOp, Tx } from './core'

const SETTINGS = ['name', 'isPublic', 'accessPolicy', 'allowedExtensions', 'allowedMimeTypes', 'blockExecutables', 'maxFileSizeBytes', 'overwriteStrategy'] as const

async function contents(bucketId: string): Promise<number> {
  const [files, uploads] = await Promise.all([
    prisma.storageFile.count({ where: { bucketId } }),
    prisma.multipartUpload.count({ where: { bucketId } }),
  ])
  return files + uploads
}

export const storageAdapter: ResourceAdapter = {
  id: 'storage',

  async capture(projectId) {
    const rows = await prisma.storageBucket.findMany({
      where: { projectId },
      include: { _count: { select: { files: true, multipartUploads: true } } },
    })
    const out: Record<string, ResourceItem> = {}
    for (const b of rows) {
      out[`bucket:${b.id}`] = {
        label: `bucket ${b.name}`,
        fields: {
          name: b.name,
          isPublic: b.isPublic,
          accessPolicy: b.accessPolicy,
          allowedExtensions: [...b.allowedExtensions].sort(),
          allowedMimeTypes: [...b.allowedMimeTypes].sort(),
          blockExecutables: b.blockExecutables,
          maxFileSizeBytes: b.maxFileSizeBytes.toString(),
          overwriteStrategy: b.overwriteStrategy,
        },
        meta: { files: b._count.files + b._count.multipartUploads },
      }
    }
    return out
  },

  irreversible(op): Irreversible | null {
    if (op.before && !op.after && Number(op.before.meta?.files ?? 0) > 0) {
      return { reason: `The files in ${op.before.label} were deleted with it, so it does not come back.`, partial: false }
    }
    return null
  },

  async liveCheck(_projectId, op): Promise<Irreversible | null> {
    if (op.before || !op.after) return null
    const n = await contents(op.key.slice('bucket:'.length))
    return n > 0
      ? { reason: `${capital(op.after.label)} holds ${n} file${n === 1 ? '' : 's'} written since, so it stays, with them.`, partial: false }
      : null
  },

  async apply(tx: Tx, projectId: string, op: ResourceOp) {
    const id = op.key.slice('bucket:'.length)
    if (!op.before) {
      // Only an empty bucket reaches here (liveCheck); counted again inside the transaction.
      const [files, uploads] = await Promise.all([
        tx.storageFile.count({ where: { bucketId: id } }),
        tx.multipartUpload.count({ where: { bucketId: id } }),
      ])
      if (files + uploads > 0) throw new Error(`${op.after!.label} holds files written since; it was not removed.`)
      await tx.storageBucket.deleteMany({ where: { id, projectId } })
      return
    }
    const data = fieldsToRow(op.before.fields)
    const existing = await tx.storageBucket.findFirst({ where: { id, projectId }, select: { id: true } })
    if (existing) await tx.storageBucket.update({ where: { id }, data })
    else await tx.storageBucket.create({ data: { id, projectId, ...data } })
  },

  async afterCommit(projectId, op) {
    const { storageService } = await import('@/lib/services/storage')
    const svc = storageService as unknown as { ensureBucketDir?: (p: string, n: string) => Promise<void> }
    if (op.before && typeof svc.ensureBucketDir === 'function') {
      await svc.ensureBucketDir(projectId, String(op.before.fields.name)).catch(() => {})
    }
  },
}

function fieldsToRow(f: Record<string, unknown>) {
  const row: Record<string, unknown> = {}
  for (const k of SETTINGS) if (k in f) row[k] = k === 'maxFileSizeBytes' ? BigInt(String(f[k])) : f[k]
  return row as {
    name: string; isPublic: boolean; accessPolicy: string; allowedExtensions: string[]; allowedMimeTypes: string[]
    blockExecutables: boolean; maxFileSizeBytes: bigint; overwriteStrategy: string
  }
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
