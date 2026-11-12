/**
 * WHO SENT A STORED FILE
 * ======================
 *
 * `StorageFile.uploadedBy` is the END USER who uploaded a file, the identity
 * `owner_only` buckets compare against (lib/storage/access-policy.ts), and it
 * is null for everything else: an upload with only the public key and no
 * signed-in user, a server's upload with a service key, and the owner's own
 * upload from the console. So the console could not tell an anonymous caller
 * from the owner, and production QA (2026-11-09) could not see that someone
 * with only the public key had put anon.png into a store's bucket.
 *
 * `uploadedBy` keeps its one meaning. The kind of uploader is recorded beside
 * it, in the row's `metadata.uploader`, by every upload path, and read back
 * here. A row written before this was recorded says only what `uploadedBy`
 * says: an end user, or nothing.
 */

export const UPLOADER_KINDS = ['end_user', 'anonymous', 'server_key', 'console'] as const
export type UploaderKind = (typeof UPLOADER_KINDS)[number]

export interface UploaderRecord {
  kind: UploaderKind
  /** The key an `anonymous` or `server_key` upload came with. */
  apiKeyId?: string
  /** The platform account a `console` upload came from. */
  platformUserId?: string
}

/**
 * The uploader of a request to the public API: the signed-in end user when
 * there is one, otherwise the key that sent it, which is the public key
 * (anonymous) or a service key (a server).
 */
export function apiUploader(context: {
  endUserId: string | null
  apiKey: { id: string; serviceRole: boolean }
}): UploaderRecord {
  if (context.endUserId) return { kind: 'end_user' }
  return { kind: context.apiKey.serviceRole ? 'server_key' : 'anonymous', apiKeyId: context.apiKey.id }
}

/** An upload from the console, by a platform account. */
export function consoleUploader(platformUserId: string): UploaderRecord {
  return { kind: 'console', platformUserId }
}

function isKind(value: unknown): value is UploaderKind {
  return typeof value === 'string' && (UPLOADER_KINDS as readonly string[]).includes(value)
}

/** Who sent a file, from its row. Null when nothing was recorded. */
export function uploaderOf(row: { uploadedBy: string | null; metadata: unknown }): UploaderRecord | null {
  const recorded =
    row.metadata && typeof row.metadata === 'object' ? (row.metadata as Record<string, unknown>).uploader : undefined
  if (recorded && typeof recorded === 'object' && isKind((recorded as Record<string, unknown>).kind)) {
    const r = recorded as Record<string, unknown>
    return {
      kind: r.kind as UploaderKind,
      ...(typeof r.apiKeyId === 'string' ? { apiKeyId: r.apiKeyId } : {}),
      ...(typeof r.platformUserId === 'string' ? { platformUserId: r.platformUserId } : {}),
    }
  }
  return row.uploadedBy ? { kind: 'end_user' } : null
}
