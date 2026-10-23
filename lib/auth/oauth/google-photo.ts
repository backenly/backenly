/**
 * THE GOOGLE ACCOUNT'S OWN PHOTO, OR NONE
 * =======================================
 * Google gives every account a `picture`, including the coloured letter it
 * draws for an account that never set a photo, and userinfo does not say which
 * of the two it sent. The console draws its own initials for an account with
 * no photo, so a Google letter there would be a second, different fallback.
 * The photo comes from the People API instead, whose `default` flag tells a
 * photo the person chose from the one Google generated.
 *
 * `fetchGoogleProfilePhoto` answers one of three things:
 *
 *   string     the account's own photo
 *   null       no photo of its own: show initials, and forget any photo
 *              recorded before (the person has removed theirs)
 *   undefined  Google could not say: the People API is not enabled on the
 *              Google Cloud project that owns GOOGLE_CLIENT_ID, or the call
 *              failed or timed out. Whatever was recorded stays as it is.
 *
 * The `profile` scope the sign-in already asks for is enough to read it.
 */

const PEOPLE_ME_PHOTOS = 'https://people.googleapis.com/v1/people/me?personFields=photos'

export async function fetchGoogleProfilePhoto(accessToken: string): Promise<string | null | undefined> {
  try {
    const res = await fetch(PEOPLE_ME_PHOTOS, {
      headers: { Authorization: `Bearer ${accessToken}` },
      // A photo is not worth holding a sign-in for.
      signal: AbortSignal.timeout(3_000),
    })
    if (!res.ok) {
      // The status alone: a 403 here is almost always the People API not being
      // enabled for this OAuth client's project.
      console.warn(`[Google profile photo] People API returned ${res.status}`)
      return undefined
    }
    return googleProfilePhoto(await res.json())
  } catch (error) {
    console.warn('[Google profile photo] People API request failed:', (error as Error)?.name || 'Error')
    return undefined
  }
}

/**
 * The account's own photo from a `people/me?personFields=photos` response, or
 * null. The primary photo is the one Google shows for the account; the field
 * is omitted when false, so only `default: true` marks Google's letter.
 */
export function googleProfilePhoto(person: unknown): string | null {
  const photos = (person as { photos?: unknown } | null)?.photos
  if (!Array.isArray(photos) || photos.length === 0) return null
  const entries = photos as Array<{ url?: unknown; default?: unknown; metadata?: { primary?: unknown } } | null>
  const photo = entries.find((p) => p?.metadata?.primary === true) ?? entries[0]
  if (!photo || photo.default === true || photo.default === 'true') return null
  return isGooglePhotoUrl(photo.url) ? photo.url : null
}

/** Only an https address on Google's photo host is ever handed to an <img>. */
function isGooglePhotoUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 2048) return false
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && url.hostname.endsWith('.googleusercontent.com')
  } catch {
    return false
  }
}
