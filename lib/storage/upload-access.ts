/**
 * WHO MAY UPLOAD INTO A BUCKET
 * ============================
 *
 * Writing to a project's storage through the public API needs a signed-in end
 * user or a server's service-role key (requireStorageWriter,
 * lib/api/v1/middleware.ts), and an end user changes only the files they
 * uploaded. Which of them may upload into a given bucket is the bucket's to
 * say, in `StorageBucket.uploadPolicy`:
 *
 *   signed_in    any signed-in end user of the project; each still changes
 *                only their own files. For what an app's users send: profile
 *                photos, attachments.
 *   server_only  only a service-role key, which only the app's server holds,
 *                and the project's team from the console. For what the app
 *                publishes itself: product photos, downloads.
 *
 * Who may READ a bucket's files is a separate rule (lib/storage/access-policy.ts).
 *
 * ── What a bucket starts with ───────────────────────────────────────────────
 *
 * A bucket made on purpose (by an agent, or by Backenly's own build) takes
 * `server_only` unless whoever makes it asks for `signed_in`. Established
 * stores start closed the same way: Supabase Storage takes no upload until a
 * policy allows it, Firebase Storage's production rules refuse writes, and an
 * Appwrite bucket needs a create permission. An import asks for `signed_in`,
 * so the app it moves in keeps uploading as it did. A bucket an upload creates
 * (the SDK uploads to `default`, which the first upload creates) takes
 * `signed_in`, or the upload that created it would be refused. Every bucket
 * from before buckets said this took uploads from signed-in users, and the
 * migration that added the column kept that for each of them.
 *
 * The rule is read when each upload arrives, as the read rule is when each read
 * does, so a change applies from the next upload, including the next step of
 * one already under way.
 */

export const UPLOAD_RULES = ['signed_in', 'server_only'] as const
export type UploadRule = (typeof UPLOAD_RULES)[number]

export function isUploadRule(value: unknown): value is UploadRule {
  return typeof value === 'string' && (UPLOAD_RULES as readonly string[]).includes(value)
}

/** What a bucket made on purpose takes, unless whoever makes it asks for signed_in. */
export const NEW_BUCKET_UPLOADS: UploadRule = 'server_only'

/** What a bucket an upload creates takes, so that upload, and the app's next ones, go in. */
export const AUTO_CREATED_BUCKET_UPLOADS: UploadRule = 'signed_in'

/**
 * A stored rule, read safely. Anything unrecognised takes uploads from the
 * server alone: a rule this build cannot read must not let every user in.
 */
export function uploadRuleOf(value: unknown): UploadRule {
  return isUploadRule(value) ? value : 'server_only'
}

/**
 * May this caller of the public API upload into a bucket with this rule? A
 * service-role key always may. Anyone else reaching here is a signed-in end
 * user (requireStorageWriter turned away the rest), who may when the bucket
 * takes uploads from signed-in users.
 */
export function mayUpload(rule: unknown, caller: { serviceRole?: boolean | null }): boolean {
  return caller.serviceRole === true || uploadRuleOf(rule) === 'signed_in'
}

/** The call that lets a bucket's signed-in users upload, as an agent makes it. */
export function letSignedInUsersCall(bucketName: string): string {
  return `storage { action: "set_uploads", bucketName: ${JSON.stringify(bucketName)}, uploads: "signed_in" }`
}

/**
 * Who may upload into a bucket, and how to change it, in one sentence for an
 * agent: so one building profile photos knows to ask for signed_in.
 */
export function whoMayUpload(bucketName: string, rule: unknown): string {
  return uploadRuleOf(rule) === 'signed_in'
    ? `Any signed-in user of your app can upload into ${bucketName}; each changes only their own files.`
    : `Only your app's server can upload into ${bucketName}, with a service-role key. ` +
        `If your users upload files here (profile photos, attachments), let them: ${letSignedInUsersCall(bucketName)}.`
}

/** What an end user's upload into a server_only bucket is answered with: what happened, and what to do. */
export function serverOnlyRefusal(bucketName: string): string {
  return (
    `Bucket "${bucketName}" takes uploads only from your app's server, with a service-role key. ` +
    `To let signed-in users upload into it, set its uploads to signed_in: in the console under Storage → ${bucketName} → ` +
    `Upload access, or with ${letSignedInUsersCall(bucketName)}.`
  )
}
