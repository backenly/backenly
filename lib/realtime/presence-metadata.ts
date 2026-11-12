/**
 * HOW LARGE PRESENCE METADATA MAY BE
 * ==================================
 * A presence change travels as a pg_notify payload, which PostgreSQL caps at
 * 8,000 bytes, and the presence trigger puts the user's metadata inside it.
 * Metadata past that made pg_notify raise "payload string too long", which
 * failed the presence upsert: the request answered 500 and the user never
 * appeared online, with nothing saying why (#620). Both presence routes
 * (app/api/v1/[projectId]/presence/route.ts and server/routes/presence.ts)
 * now refuse it first, with 413.
 *
 * The limit is on the metadata as JSON. PostgreSQL keeps it as jsonb, and the
 * trigger sends jsonb's text, which puts a space after every `:` and `,`: at
 * most half as long again, for metadata made only of one-character values.
 * 4 KB of JSON stays under the payload cap with the rest of the frame, whatever
 * its shape.
 */

export const PRESENCE_METADATA_MAX_BYTES = 4_096

export const PRESENCE_METADATA_TOO_LARGE = 'PRESENCE_METADATA_TOO_LARGE'

export interface PresenceMetadataRefusal {
  status: 413
  body: { error: string; code: typeof PRESENCE_METADATA_TOO_LARGE; bytes: number; limitBytes: number }
}

/** The 413 for metadata over the limit, or null when it fits. */
export function presenceMetadataTooLarge(metadata: unknown): PresenceMetadataRefusal | null {
  const bytes = Buffer.byteLength(JSON.stringify(metadata ?? {}), 'utf8')
  if (bytes <= PRESENCE_METADATA_MAX_BYTES) return null
  return {
    status: 413,
    body: {
      error:
        `Presence metadata is ${bytes} bytes as JSON, over the ${PRESENCE_METADATA_MAX_BYTES}-byte (4 KB) limit. ` +
        'Keep it to small display fields, such as a name or an avatar URL, not the image itself.',
      code: PRESENCE_METADATA_TOO_LARGE,
      bytes,
      limitBytes: PRESENCE_METADATA_MAX_BYTES,
    },
  }
}
