/**
 * Backenly's mark, carried inside platform email rather than linked.
 *
 * The same bytes as public/apple-touch-icon.png, which a test holds equal, so
 * the mark in the inbox is the one on the site.
 *
 * Carried inside the message because backenly.com answers every request,
 * images included, with `Cross-Origin-Resource-Policy: same-site`: a mail
 * client that loads images itself with a browser engine, rather than through
 * a proxy the way Gmail does, is refused a linked one. An embedded mark also
 * shows when remote images are off, and fetching it tells no one the message
 * was opened.
 */

/** The Content-ID a message's HTML names the mark by: `<img src="cid:...">`. */
export const BACKENLY_MARK_CID = 'logo@backenly.com'

/** 180x180 PNG, 3,153 bytes. */
export const BACKENLY_MARK_PNG_BASE64 =
  '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' +
  'QmCC'

/** The mark as a nodemailer attachment, shown inline where the HTML names it. */
export function backenlyMarkAttachment() {
  return {
    filename: 'backenly.png',
    content: Buffer.from(BACKENLY_MARK_PNG_BASE64, 'base64'),
    contentType: 'image/png',
    cid: BACKENLY_MARK_CID,
    contentDisposition: 'inline' as const,
  }
}
