/**
 * Signed links for EXPORTING a project's files, which work while it is paused.
 *
 * A paused project's download route refuses everyone who is not a member of the
 * project (app/api/storage/files/[fileId]/download), including holders of an
 * ordinary signed link, because those are usually handed to an app's end users.
 * But the owner has to be able to take their data out of a paused project,
 * above all once resuming it requires a paid plan. So an export link is its own
 * credential: minted only by the admin-only export route, and honoured through
 * a pause where an ordinary link is not.
 *
 * It is kept apart from the ordinary link in two ways, so neither can pass for
 * the other: a distinct `x.` prefix, and a distinct HMAC domain (`export:` is
 * part of the signed message). An ordinary token therefore never verifies here,
 * and an export token never verifies as an ordinary one.
 */
import crypto from 'crypto'

const PREFIX = 'x.'

export function isExportToken(token: string): boolean {
  return token.startsWith(PREFIX)
}

export function signExportToken(
  fileId: string,
  ttlSeconds: number,
  secret: string,
  now: number = Date.now(),
): string {
  const expires = now + ttlSeconds * 1000
  const mac = crypto.createHmac('sha256', secret).update(`export:${fileId}:${expires}`).digest('hex')
  return `${PREFIX}${expires}:${mac}`
}

/** Constant-time check of an export token for exactly this object. */
export function verifyExportToken(
  fileId: string,
  token: string,
  secret: string,
  now: number = Date.now(),
): boolean {
  if (!isExportToken(token)) return false
  const [expiresStr, mac] = token.slice(PREFIX.length).split(':')
  const expires = parseInt(expiresStr, 10)
  if (!expires || now > expires || !mac) return false

  const expected = crypto.createHmac('sha256', secret).update(`export:${fileId}:${expires}`).digest('hex')
  if (mac.length !== expected.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))
  } catch {
    return false
  }
}
