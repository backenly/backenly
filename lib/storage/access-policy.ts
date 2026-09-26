/**
 * WHO MAY READ A STORED OBJECT
 * ============================
 *
 * `StorageBucket.accessPolicy` already existed with four values. What it was
 * used for was deriving `StorageFile.isPublic` AT UPLOAD TIME and choosing a
 * `Cache-Control` header. What decided whether bytes were served was
 * `StorageFile.isPublic` — a snapshot.
 *
 * So an operator who tightened a bucket from `public_read` to `private` got a
 * success response, a bucket row that said `private`, and every object already
 * in it still served to an anonymous caller. Verified against the real route:
 * 200, with the bytes, after the change. That is the worst moment for this to
 * fail, because an operator reaches for "make this private" precisely when
 * something has already leaked.
 *
 * And it ran the other way too. `/api/v1/{projectId}/storage/upload` read
 * `isPublic` from the request and stored `isPublic || bucket.isPublic`, so any
 * API-key holder could put a world-readable object inside a `private` bucket.
 *
 * ── The bucket is a CEILING, evaluated per request ──────────────────────────
 *
 * A file may be more restricted than its bucket. It may never be less. The
 * alternative — a file permitted to out-rank its bucket — IS the defect above,
 * so it was never really a second option. And the existing `isPublic` values
 * were DERIVED from the bucket policy at upload rather than chosen per object,
 * so there is no record of per-file operator intent that this could be
 * discarding.
 *
 * Evaluated when the request arrives, not cascaded into rows on update. A
 * cascade would fix the reported case and leave every other writer of that
 * column able to reopen the hole; there are four of them.
 *
 * ── What this module is not ─────────────────────────────────────────────────
 *
 * It is not an ACL engine, and deliberately not RLS-for-files. Backenly's model
 * is governed actions over a small set of named policies, not arbitrary rules a
 * dashboard user composes. Four policies, each with a stated meaning, is the
 * whole vocabulary.
 */

export const ACCESS_POLICIES = ['public_read', 'cdn_cacheable', 'private', 'owner_only'] as const
export type AccessPolicy = (typeof ACCESS_POLICIES)[number]

export function isAccessPolicy(value: unknown): value is AccessPolicy {
  return typeof value === 'string' && (ACCESS_POLICIES as readonly string[]).includes(value)
}

/**
 * The default for a bucket whose policy is missing or unrecognised.
 *
 * `private`, because an unreadable policy must not mean "serve it to anyone".
 * A row predating the column, or written by a future version this build does
 * not understand, fails closed.
 */
export const FALLBACK_POLICY: AccessPolicy = 'private'

export function normalisePolicy(value: unknown): AccessPolicy {
  return isAccessPolicy(value) ? value : FALLBACK_POLICY
}

/** Policies under which an object MAY be world-readable, if the file allows it. */
const PUBLIC_CAPABLE: ReadonlySet<AccessPolicy> = new Set<AccessPolicy>(['public_read', 'cdn_cacheable'])

/** Does this policy permit a file in the bucket to be public at all? */
export function policyAllowsPublic(policy: unknown): boolean {
  return PUBLIC_CAPABLE.has(normalisePolicy(policy))
}

/**
 * Who is asking.
 *
 * `operator` is a platform account with access to the owning project — the
 * person who administers the bucket. `endUser` is an authenticated user OF the
 * project, which is a different identity system entirely and must never be
 * conflated with the first.
 */
export type Reader =
  | { kind: 'anonymous' }
  /**
   * Presented a valid, unexpired signed link for THIS object. `purpose:
   * 'export'` marks a link minted by the admin-only export route
   * (lib/storage/export-token.ts), which still works while the project is paused.
   */
  | { kind: 'signed'; purpose?: 'export' }
  | { kind: 'operator'; userId: string }
  | { kind: 'endUser'; userId: string }
  /**
   * Holds a valid platform session and has NO access to the owning project.
   *
   * Its own kind rather than being folded in with `endUser`, which the first
   * version did. The decisions happened to come out the same, but calling a
   * platform stranger an end user of the project is wrong in a way that would
   * eventually produce a wrong answer — `owner_only` compares against
   * `uploadedBy`, and a comparison that is only accidentally false is not a
   * control.
   */
  | { kind: 'stranger'; userId: string }

export interface StoredObject {
  /** The bucket's CURRENT policy, read at request time. */
  bucketPolicy: string | null | undefined
  /** The file's own flag. Can only narrow, never widen. */
  fileIsPublic: boolean
  /** The end user who uploaded it, when one is recorded. */
  uploadedBy: string | null | undefined
}

export interface AccessDecision {
  allowed: boolean
  /** Why, for the log and for the test that asserts the reason. */
  reason: string
  /** The HTTP status a refusal should carry. */
  status: 200 | 401 | 403
}

const ALLOW = (reason: string): AccessDecision => ({ allowed: true, reason, status: 200 })

/**
 * Refused because the caller has not identified themselves. 401 invites them to.
 */
const UNAUTHENTICATED = (reason: string): AccessDecision => ({ allowed: false, reason, status: 401 })

/**
 * Refused although the caller IS identified. 403, because retrying with the
 * same credential will not help.
 */
const FORBIDDEN = (reason: string): AccessDecision => ({ allowed: false, reason, status: 403 })

/**
 * May this reader read this object, under the bucket's current policy?
 *
 * The single decision. Every serving path calls this rather than re-deriving
 * the rule, which is what let two paths disagree in the first place.
 */
export function mayRead(object: StoredObject, reader: Reader): AccessDecision {
  const policy = normalisePolicy(object.bucketPolicy)

  // ── The operator of the project ─────────────────────────────────────────
  //
  // Allowed under every policy. `owner_only` narrows which END USER may read an
  // object; it does not lock an operator out of storage they administer, and
  // reading that as "nobody but the uploader" would make the dashboard unable
  // to show a project its own files.
  if (reader.kind === 'operator') {
    return ALLOW(`operator of the project may read under ${policy}`)
  }

  // ── An export link ──────────────────────────────────────────────────────
  //
  // Minted only by the admin-only export route, for one object, for an hour. It
  // carries a project administrator's authority into a download that has no
  // session, so it reads what the administrator could, `owner_only` included.
  // An ordinary signed link can never pass for one (lib/storage/export-token.ts).
  if (reader.kind === 'signed' && reader.purpose === 'export') {
    return ALLOW(`export link minted by a project administrator, under ${policy}`)
  }

  // ── Identified, and entitled to nothing here ────────────────────────────
  //
  // A valid platform session for somebody with no access to this project.
  // Authentication is not authorization. They may read what anyone may read,
  // and nothing else.
  if (reader.kind === 'stranger') {
    if (policyAllowsPublic(policy) && object.fileIsPublic) {
      return ALLOW(`${policy} bucket, file marked public`)
    }
    return FORBIDDEN('no access to the project that owns this object')
  }

  switch (policy) {
    case 'public_read':
    case 'cdn_cacheable': {
      // The bucket permits public objects; the file decides whether it is one.
      // This is the narrowing direction, which is always allowed.
      if (object.fileIsPublic) return ALLOW(`${policy} bucket, file marked public`)
      if (reader.kind === 'signed') return ALLOW('valid signed link to a non-public file')
      return UNAUTHENTICATED(`${policy} bucket but the file is not public`)
    }

    case 'private': {
      // Not public to anyone. A signed link is the deliberate, time-limited
      // grant that exists for this case.
      if (reader.kind === 'signed') return ALLOW('valid signed link to a private file')
      if (reader.kind === 'endUser') {
        // End users read private objects through a signed link the app mints
        // for them, not by presenting their session to the object route. That
        // keeps "which end user may see which object" a decision the project's
        // own code makes, rather than one this module guesses at.
        return FORBIDDEN('private bucket: end users need a signed link')
      }
      return UNAUTHENTICATED('private bucket')
    }

    case 'owner_only': {
      // The one policy that is about an END USER's identity.
      //
      // Before this module it was accepted, stored, validated, and behaved
      // exactly like `private`: the serving path had no concept of an owner, so
      // the value promised per-uploader restriction and delivered project-wide
      // access. `StorageFile.uploadedBy` was already being recorded, so the
      // information was there and unused.
      if (reader.kind === 'endUser') {
        if (!object.uploadedBy) {
          // No recorded owner means nobody can satisfy "is the owner". Failing
          // closed is the only safe reading; treating an absent owner as "anyone
          // in the project" would turn owner_only back into private-for-all.
          return FORBIDDEN('owner_only bucket: this object records no owner')
        }
        return object.uploadedBy === reader.userId
          ? ALLOW('owner_only bucket, reader uploaded this object')
          : FORBIDDEN('owner_only bucket: a different end user uploaded this object')
      }
      // A signed link is an anonymous grant, and `owner_only` is a statement
      // that anonymous reading is not acceptable for this bucket. An hour-long
      // token that outlived the operator locking the bucket down would be the
      // same defect in another costume.
      if (reader.kind === 'signed') {
        return FORBIDDEN('owner_only bucket: signed links do not identify the owner')
      }
      return UNAUTHENTICATED('owner_only bucket')
    }
  }
}

/**
 * The `Cache-Control` an allowed response should carry.
 *
 * Keyed off the same policy the access decision used, so a response can never be
 * cached publicly under a policy that did not permit public reading. The old
 * code chose this from the bucket policy while gating access on the file column,
 * which meant a `private` bucket could serve a file with `public` caching.
 */
export function cacheControlFor(policy: unknown, fileIsPublic: boolean): string {
  const normalised = normalisePolicy(policy)
  if (!policyAllowsPublic(normalised) || !fileIsPublic) return 'private, no-store'
  return normalised === 'public_read'
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=86400, stale-while-revalidate=604800'
}

/**
 * Clamp a requested per-file `isPublic` to what the bucket permits.
 *
 * The write-time half of the ceiling. `/api/v1/{projectId}/storage/upload` took
 * `isPublic` from the request body and stored `isPublic || bucket.isPublic`, so
 * an API-key holder could put a world-readable object into a `private` bucket.
 * Serving now refuses that object, and this stops the row being written in the
 * first place, so the two layers agree instead of one quietly cleaning up after
 * the other.
 */
export function clampIsPublic(requested: boolean | undefined, bucketPolicy: unknown): boolean {
  if (!policyAllowsPublic(bucketPolicy)) return false
  return requested ?? true
}

/** Operator-facing description of each policy, for the dashboard. */
export const POLICY_LABELS: Record<AccessPolicy, { title: string; means: string }> = {
  public_read: {
    title: 'Public',
    means: 'Anyone with the URL can read objects marked public. Cached aggressively.',
  },
  cdn_cacheable: {
    title: 'Public, CDN cached',
    means: 'Same as public, with a shorter cache window suited to objects that change.',
  },
  private: {
    title: 'Private',
    means:
      'Only this project’s operators, or a time-limited signed link. End users read through a signed link your app requests.',
  },
  owner_only: {
    title: 'Owner only',
    means:
      'Only the end user who uploaded the object, plus this project’s operators. Signed links do not work, because they do not identify the owner.',
  },
}

/**
 * Does this deployment serve public objects from a CDN rather than from here?
 *
 * The one case the access policy cannot govern. With the S3 driver and a public
 * CDN base configured, a public object's URL points at the CDN, so those reads
 * never reach the route that enforces the policy and tightening a bucket cannot
 * revoke them until the CDN object or cache is purged.
 *
 * Read on the SERVER and reported to the dashboard, rather than guessed in the
 * browser, because whether a control can be revoked at all is not something a
 * client should be inferring.
 *
 * Mirrors `S3StorageService.publicCdnBase()`; a `STORAGE_CDN_URL` that is not a
 * URL is ignored there, so it is ignored here too.
 */
export function cdnServesPublicObjects(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.STORAGE_DRIVER || 'local') !== 's3') return false
  for (const key of ['STORAGE_CDN_URL', 'STORAGE_S3_PUBLIC_URL']) {
    const value = (env[key] ?? '').trim()
    if (!value) continue
    try {
      new URL(value)
      return true
    } catch {
      // Not a URL, so the driver ignores it and so does this.
    }
  }
  return false
}
