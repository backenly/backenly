/**
 * Backenly hands nodemailer plain addresses only (lib/email/address.ts).
 *
 * nodemailer's address parser took quadratic time or longer on comments,
 * brackets and quotes (GHSA-v53p-9fqp-m79j, GHSA-prgh-xp8r-p3m5), and a comment
 * could move where mail is delivered
 * (`attacker@evil.example(x).company.com` went to evil.example). Each needs a
 * character a plain address does not have, so it never reaches the parser.
 */
import nodemailer from 'nodemailer'
import {
  isDeliverableAddress,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_EMAIL_LENGTH,
  plainAddressesOnly,
  UndeliverableAddressError,
  withPlainAddresses,
} from '@/lib/email/address'

const ATTACK = '[x]'.repeat(40_000) + '(@)b.co'

describe('isDeliverableAddress', () => {
  it.each([
    'a@b.co',
    'first.last+tag@sub.example.com',
    "o'brien@example.ie",
    'UPPER@EXAMPLE.ORG',
    'x_y-z@a-b.example.co.uk',
    `${'l'.repeat(64)}@example.com`,
  ])('accepts %s', (address) => {
    expect(isDeliverableAddress(address)).toBe(true)
  })

  it.each([
    ['the GHSA-v53p shape', ATTACK],
    ['a comment that moves delivery', 'attacker@evil.example(x).company.com'],
    ['a quoted local part', '"a b"@example.com'],
    ['angle brackets', '<a@b.co>'],
    ['two addresses', 'a@b.co,c@d.co'],
    ['a domain without a dot', 'a@localhost'],
    ['an IP literal', 'a@[127.0.0.1]'],
    ['a double dot', 'a..b@example.com'],
    ['a leading dot', '.a@example.com'],
    ['a hyphen opening a label', 'a@-b.example.com'],
    ['a numeric top-level domain', 'a@example.123'],
    ['a local part over 64', `${'l'.repeat(65)}@example.com`],
    ['an address over 254', `a@${'d'.repeat(63)}.${'d'.repeat(63)}.${'d'.repeat(63)}.${'d'.repeat(60)}.com`],
    ['not a string', 42],
  ])('refuses %s', (_label, value) => {
    expect(isDeliverableAddress(value)).toBe(false)
  })

  it('answers a 10 MB string at once: the length is checked before the pattern', () => {
    const started = Date.now()
    expect(isDeliverableAddress('a'.repeat(10 * 1024 * 1024) + '@b.co')).toBe(false)
    expect(isDeliverableAddress(ATTACK)).toBe(false)
    expect(Date.now() - started).toBeLessThan(200)
    expect(MAX_EMAIL_LENGTH).toBe(254)
  })
})

describe('withPlainAddresses', () => {
  it('hands `Name <address>` on as { name, address }, so the name is never parsed', () => {
    expect(withPlainAddresses({ from: 'Acme, Inc. <no-reply@acme.example>', to: 'a@b.co' })).toEqual({
      from: { name: 'Acme, Inc.', address: 'no-reply@acme.example' },
      to: 'a@b.co',
    })
    expect(withPlainAddresses({ from: '"Quoted (Name)" <q@acme.example>', to: ['a@b.co', { name: 'C', address: 'c@d.co' }] })).toEqual({
      from: { name: 'Quoted (Name)', address: 'q@acme.example' },
      to: ['a@b.co', { name: 'C', address: 'c@d.co' }],
    })
  })

  it('shortens a long display name instead of refusing the mail', () => {
    const out = withPlainAddresses({ from: { name: 'N'.repeat(1000), address: 'a@b.co' }, to: 'c@d.co' })
    expect((out.from as { name: string }).name).toHaveLength(MAX_DISPLAY_NAME_LENGTH)
  })

  it.each([
    ['the GHSA-v53p shape in to', { to: ATTACK }, 'to'],
    ['a misdirecting comment in to', { to: 'attacker@evil.example(x).company.com' }, 'to'],
    ['a 650 KB sender name (GHSA-prgh)', { from: `${'N'.repeat(650_000)} <a@b.co>`, to: 'c@d.co' }, 'from'],
    ['a line break in a name', { from: { name: 'A\r\nBcc: x@y.co', address: 'a@b.co' }, to: 'c@d.co' }, 'from'],
    ['one bad address among several', { to: ['a@b.co', 'b@c.co(x)'] }, 'to'],
    ['an object without an address', { to: { name: 'A' } }, 'to'],
    ['no recipient', { from: 'a@b.co' }, 'to'],
  ])('refuses %s, naming the field', (_label, message, field) => {
    expect(() => withPlainAddresses(message as Record<string, unknown>)).toThrow(UndeliverableAddressError)
    try {
      withPlainAddresses(message as Record<string, unknown>)
    } catch (err) {
      expect((err as UndeliverableAddressError).field).toBe(field)
    }
  })
})

describe('plainAddressesOnly', () => {
  it('refuses a bad message before the transport sees it, for a promise and for a callback', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'x' })
    const transport = plainAddressesOnly({ sendMail })
    await expect(transport.sendMail({ to: ATTACK, subject: 's' })).rejects.toBeInstanceOf(UndeliverableAddressError)
    const callback = jest.fn()
    transport.sendMail({ to: ATTACK, subject: 's' }, callback)
    expect(callback).toHaveBeenCalledWith(expect.any(UndeliverableAddressError))
    expect(sendMail).not.toHaveBeenCalled()
  })

  it('sends a good message through nodemailer, with the display name encoded rather than parsed', async () => {
    const transport = plainAddressesOnly(nodemailer.createTransport({ jsonTransport: true }))
    const info = await transport.sendMail({
      from: 'Acme, Inc. <no-reply@acme.example>',
      to: 'shopper@example.com',
      subject: 'Your link',
      text: 'hello',
    })
    const sent = JSON.parse(info.message as unknown as string)
    expect(sent.from).toEqual({ address: 'no-reply@acme.example', name: 'Acme, Inc.' })
    expect(sent.to).toEqual([{ address: 'shopper@example.com', name: '' }])
  })
})
