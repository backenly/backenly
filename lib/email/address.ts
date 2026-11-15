/**
 * EMAIL ADDRESSES BACKENLY WILL HAND TO NODEMAILER
 * ================================================
 *
 * nodemailer parses every address it is given (addressparser), and that
 * parser has been the target of a run of advisories: inputs made of comments,
 * brackets and quotes that take quadratic time or longer, and addresses whose
 * comment moves where the mail is delivered
 * (`attacker@evil.example(x).company.com`). Every
 * one of them needs a character an ordinary address does not have.
 *
 * So an address Backenly sends to, or names as a sender, is first checked here
 * against the plain form people actually use: the dot-atom local part and a
 * dotted domain of letters, digits and hyphens (RFC 5322 without quoted strings
 * or comments, as browsers check `type="email"`, but requiring a dot in the
 * domain), at most 254 characters (RFC 5321). The length is checked before the
 * pattern, and the pattern cannot backtrack: every repetition is separated by a
 * character the repeated part cannot contain.
 *
 * A display name never reaches the parser either: `Name <address>` strings are
 * split here and handed over as `{ name, address }`, which nodemailer encodes
 * without parsing.
 */

/** RFC 5321's limit on a forward path, which is what an address must fit in. */
export const MAX_EMAIL_LENGTH = 254
/** RFC 5321's limit on a local part. */
const MAX_LOCAL_LENGTH = 64
/** The longest display name Backenly sends with: the sender names people set, and app names. */
export const MAX_DISPLAY_NAME_LENGTH = 128

const ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+"
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
const PLAIN_ADDRESS = new RegExp(`^${ATOM}(?:\\.${ATOM})*@(?:${LABEL}\\.)+[A-Za-z]{2,63}$`)

/**
 * An address in the plain form, short enough to carry: the only kind Backenly
 * sends to or from. A boolean, not a type guard: a string that fails it is
 * still a string.
 */
export function isDeliverableAddress(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > MAX_EMAIL_LENGTH) return false
  const at = value.lastIndexOf('@')
  if (at < 1 || at > MAX_LOCAL_LENGTH) return false
  return PLAIN_ADDRESS.test(value)
}

/** Why a message was not handed to nodemailer. */
export class UndeliverableAddressError extends Error {
  constructor(readonly field: string) {
    super(`Not sent: the ${field} address is not a plain email address of at most ${MAX_EMAIL_LENGTH} characters.`)
    this.name = 'UndeliverableAddressError'
  }
}

type Mailbox = string | { name: string; address: string }

/** The longest `Name <address>` string looked at: far beyond any real sender, small enough to scan. */
const MAX_NAMED_LENGTH = 4096

/** One address field's value, as nodemailer receives it: plain addresses and `{ name, address }`. */
function mailbox(field: string, value: unknown): Mailbox {
  if (typeof value === 'string') {
    const text = value.trim()
    if (isDeliverableAddress(text)) return text
    // `Name <address>`, the form Backenly builds senders in, split by scanning
    // for the last `<` (no pattern, linear in the length) and handed on as
    // { name, address }, so nodemailer never parses the name.
    if (text.length <= MAX_NAMED_LENGTH && text.endsWith('>')) {
      const open = text.lastIndexOf('<')
      const address = open >= 0 ? text.slice(open + 1, -1).trim() : ''
      if (isDeliverableAddress(address)) return named(field, text.slice(0, open), address)
    }
    throw new UndeliverableAddressError(field)
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const { name, address } = value as { name?: unknown; address?: unknown }
    if (typeof address === 'string' && isDeliverableAddress(address) && (name === undefined || name === null || typeof name === 'string')) {
      return named(field, typeof name === 'string' ? name : '', address)
    }
  }
  throw new UndeliverableAddressError(field)
}

/**
 * A display name as nodemailer is given it: surrounding quotes taken off, at
 * most MAX_DISPLAY_NAME_LENGTH characters (a longer one, such as a long app
 * name, is shortened rather than the mail refused). A line break is refused: it
 * would start a header of its own.
 */
function named(field: string, raw: string, address: string): Mailbox {
  if (/[\r\n]/.test(raw)) throw new UndeliverableAddressError(field)
  let name = raw.trim()
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).trim()
  name = name.slice(0, MAX_DISPLAY_NAME_LENGTH).trim()
  return name ? { name, address } : address
}

const FIELDS = ['from', 'sender', 'to', 'cc', 'bcc', 'replyTo'] as const

/**
 * The message with every address field checked and in the form nodemailer does
 * not parse; throws UndeliverableAddressError for anything else. A message with
 * no recipient is refused too.
 */
export function withPlainAddresses<T extends Record<string, unknown>>(message: T): T {
  const out: Record<string, unknown> = { ...message }
  for (const field of FIELDS) {
    const value = message[field]
    if (value === undefined || value === null || value === '') continue
    out[field] = Array.isArray(value) ? value.map((v) => mailbox(field, v)) : mailbox(field, value)
  }
  if (!out.to && !out.cc && !out.bcc) throw new UndeliverableAddressError('to')
  return out as T
}

/**
 * The transport, with every message's addresses checked before nodemailer sees
 * them (withPlainAddresses). lib/email/smtp-transport.ts builds every transport
 * Backenly sends with through this, so no send path can skip it.
 */
export function plainAddressesOnly<T extends { sendMail: (...args: any[]) => any }>(transport: T): T {
  const send = transport.sendMail.bind(transport)
  transport.sendMail = ((message: Record<string, unknown>, callback?: (...args: any[]) => void) => {
    let checked: Record<string, unknown>
    try {
      checked = withPlainAddresses(message)
    } catch (err) {
      if (typeof callback === 'function') {
        callback(err)
        return undefined
      }
      return Promise.reject(err)
    }
    return callback ? send(checked, callback) : send(checked)
  }) as T['sendMail']
  return transport
}
