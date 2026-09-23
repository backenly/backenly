/**
 * WHICH FAILURES MAY BE REPORTED AS SUCCESS, AND WHICH MAY NOT
 * ============================================================
 * Exactly one failure is allowed to look like a success: the provider refusing
 * THIS recipient, because naming it would tell a stranger that an account
 * lives at that address.
 *
 * Nodemailer raises EENVELOPE for the whole envelope, not only for a refused
 * recipient: a rejected sender, a message with no recipients, an unverified
 * sending domain refused at MAIL FROM. Masking on the bare code would let a
 * configuration fault disappear again, which is the exact failure this
 * subsystem exists to end - production spent days rejecting every message
 * while every page said "sent".
 */
import { isRecipientRefusal } from '@/lib/email/platform-delivery'

const RECIPIENT = 'ada@example.com'

describe('a refusal of this recipient, which may be masked', () => {
  it('accepts a permanent RCPT TO rejection naming exactly this address', () => {
    expect(isRecipientRefusal(
      { code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, rejected: [RECIPIENT], message: 'no such user' },
      RECIPIENT,
    )).toBe(true)
  })

  it('accepts it when the address arrives cased differently', () => {
    expect(isRecipientRefusal(
      { code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, rejected: ['Ada@Example.com'] },
      RECIPIENT,
    )).toBe(true)
  })

  it('accepts a rejected entry given as an object, as some transports report it', () => {
    expect(isRecipientRefusal(
      { code: 'EENVELOPE', command: 'RCPT TO', rejected: [{ address: RECIPIENT }], rejectedErrors: [{ responseCode: 553 }] },
      RECIPIENT,
    )).toBe(true)
  })
})

describe('everything else, which must stay a delivery failure', () => {
  it('refuses a sender-side envelope failure', () => {
    // The production shape, had it arrived at MAIL FROM: our domain, not
    // their mailbox.
    expect(isRecipientRefusal(
      { code: 'EENVELOPE', command: 'MAIL FROM', responseCode: 550, message: 'The backenly.com domain is not verified' },
      RECIPIENT,
    )).toBe(false)
  })

  it('refuses a message with no recipients defined, which is our bug', () => {
    expect(isRecipientRefusal({ code: 'EENVELOPE', message: 'No recipients defined' }, RECIPIENT)).toBe(false)
  })

  it('refuses when the error names a different address', () => {
    expect(isRecipientRefusal(
      { code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, rejected: ['someone-else@example.com'] },
      RECIPIENT,
    )).toBe(false)
  })

  it('refuses when only some of the rejected addresses are this one', () => {
    expect(isRecipientRefusal(
      { code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, rejected: [RECIPIENT, 'other@example.com'] },
      RECIPIENT,
    )).toBe(false)
  })

  it('refuses a TEMPORARY rejection, which is a retry rather than a refusal', () => {
    // Greylisting and a full mailbox both clear on their own. Reporting them
    // as delivered would lose a message that would have arrived.
    expect(isRecipientRefusal(
      { code: 'EENVELOPE', command: 'RCPT TO', responseCode: 450, rejected: [RECIPIENT] },
      RECIPIENT,
    )).toBe(false)
    expect(isRecipientRefusal(
      { code: 'EENVELOPE', command: 'RCPT TO', rejected: [RECIPIENT], rejectedErrors: [{ responseCode: 421 }] },
      RECIPIENT,
    )).toBe(false)
  })

  it('refuses an exact-recipient RCPT TO rejection that carries no SMTP status at all', () => {
    // Everything else matches, so this is the case that proves the status is
    // REQUIRED rather than merely checked when present. An empty status list
    // used to pass, because "no status is below 500" is true of nothing.
    expect(isRecipientRefusal(
      { code: 'EENVELOPE', command: 'RCPT TO', rejected: [RECIPIENT] },
      RECIPIENT,
    )).toBe(false)
    expect(isRecipientRefusal(
      { code: 'EENVELOPE', command: 'RCPT TO', rejected: [RECIPIENT], rejectedErrors: [{}] },
      RECIPIENT,
    )).toBe(false)
  })

  it('refuses a status outside 5xx even when it is above 500', () => {
    // ">= 500" is not "a 5xx". A status no SMTP server should send is
    // uncertainty, and uncertainty stays a delivery failure.
    expect(isRecipientRefusal(
      { code: 'EENVELOPE', command: 'RCPT TO', responseCode: 600, rejected: [RECIPIENT] },
      RECIPIENT,
    )).toBe(false)
  })

  it('refuses when any one of several statuses is not a 5xx', () => {
    expect(isRecipientRefusal(
      { code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, rejected: [RECIPIENT], rejectedErrors: [{ responseCode: 451 }] },
      RECIPIENT,
    )).toBe(false)
  })

  it('refuses every other error code, however it is shaped', () => {
    for (const err of [
      { code: 'EAUTH', responseCode: 535 },
      { code: 'ETIMEDOUT' },
      { code: 'ECONNREFUSED' },
      { code: 'EMESSAGE', responseCode: 550, message: 'The backenly.com domain is not verified' },
      null,
      undefined,
      new Error('something new'),
    ]) {
      expect(isRecipientRefusal(err, RECIPIENT)).toBe(false)
    }
  })

  it('refuses when there is no recipient to compare against', () => {
    expect(isRecipientRefusal({ code: 'EENVELOPE', command: 'RCPT TO', rejected: [RECIPIENT] }, '')).toBe(false)
  })
})
