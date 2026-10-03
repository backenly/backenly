/**
 * "NOT FOUND" AND "I CANNOT REACH THE BYTES" ARE DIFFERENT ANSWERS
 * ===============================================================
 *
 * Both storage drivers used to end `getFile` with:
 *
 *     } catch (error) {
 *       console.error(...)
 *       return null
 *     }
 *
 * and both callers render `null` as `404 File not found`. So while the disk was
 * unmounted, the S3 endpoint unreachable or the credential wrong, every download
 * answered with a definite statement about the world — this object does not
 * exist — that was false. The metadata row was sitting right there saying it
 * did.
 *
 * That is worse than a 500. A 404 is actionable: a syncing client prunes its
 * local copy, a retry loop stops retrying because the resource is gone, and an
 * operator reading the logs goes looking for a deletion that never happened. It
 * is the same class as a restore that reports success while doing nothing —
 * a definite claim, made by a subsystem that is not in a position to make it.
 *
 * So absence and unavailability are now distinct:
 *
 *   - no metadata row, soft-deleted, or another tenant's  ->  404, unchanged
 *   - the row exists and the bytes could not be read      ->  StorageUnavailable
 *
 * ── Why a missing FILE counts as unavailable, not as absent ─────────────────
 *
 * ENOENT from the local driver means the row says the object exists and the
 * path says it does not. That is a storage fault, not a deletion — deleting
 * through the product removes the row too. Reporting 404 would invite exactly
 * the wrong conclusion, and one read cannot distinguish "permanently lost" from
 * "the volume is not mounted yet", which is the common case and is retryable.
 * The caller therefore gets a retryable failure and the log gets the detail.
 */

export class StorageUnavailableError extends Error {
  readonly code = 'STORAGE_UNAVAILABLE'
  /** The driver's own error, for logs. Never returned to a caller. */
  readonly cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'StorageUnavailableError'
    this.cause = cause
  }
}

export function isStorageUnavailable(err: unknown): err is StorageUnavailableError {
  return err instanceof StorageUnavailableError
}
