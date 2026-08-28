/**
 * Pins both halves of the email observability contract: an operator can tell the
 * failure modes apart, and nothing sensitive reaches the log while doing so.
 */
import {
  classifyEmailError,
  describeSendFailure,
  describeSendSuccess,
  observeSend,
  recipientDomain,
  reportUnconfigured,
  sanitizeMessageId,
} from '@/lib/email/send-outcome'

// Synthetic fixture. Deliberately NOT jwt-shaped: the redactor strips the whole
// URL regardless of token format, and a `eyJ`-prefixed literal would trip
// secret scanners on a public repo for no test value.
const RESET_URL = 'https://app.example.com/auth/reset-password?token=FAKE_RESET_TOKEN_FOR_TESTS'

describe('email send observability', () => {
  describe('distinguishes the failure modes that used to look identical', () => {
    it.each<[string, Record<string, unknown>, string]>([
      ['SMTP timeout',        { code: 'ETIMEDOUT', message: 'Connection timeout' },                    'timeout'],
      ['bad credentials',     { code: 'EAUTH', responseCode: 535, message: 'Invalid login' },          'auth_failure'],
      ['recipient rejected',  { code: 'EENVELOPE', responseCode: 550, message: 'Invalid `to` field' }, 'recipient_rejected'],
      ['TLS failure',         { code: 'ETLS', message: 'certificate has expired' },                    'tls_error'],
      ['network refused',     { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' },               'network_error'],
      ['provider 5xx',        { responseCode: 554, message: 'domain is not verified' },                'provider_rejected'],
    ])('classifies %s', (_label, err, expected) => {
      expect(classifyEmailError(err).category).toBe(expected)
    })

    it('auth failure outranks the generic 5xx bucket', () => {
      // Both are true of this error; the actionable one is the credential.
      expect(classifyEmailError({ code: 'EAUTH', responseCode: 535 }).category).toBe('auth_failure')
    })

    it('falls back to unknown rather than mislabelling', () => {
      expect(classifyEmailError({ message: 'something new' }).category).toBe('unknown')
      expect(classifyEmailError(null).category).toBe('unknown')
    })
  })

  describe('never logs anything sensitive', () => {
    it('does not leak a reset URL or token from an error message', () => {
      const out = describeSendFailure('password_reset', 'ada@example.com', {
        message: `failed posting to ${RESET_URL}`,
      })
      const line = JSON.stringify(out)
      expect(line).not.toContain('token=')
      expect(line).not.toContain('SECRET')
      expect(line).not.toContain(RESET_URL)
      expect(line).toContain('[url-redacted]')
    })

    it('records the domain only — no per-recipient identifier', () => {
      const ref = recipientDomain('ada.lovelace@example.com')
      expect(ref).toBe('example.com')
      expect(ref).not.toContain('ada.lovelace')
    })

    it('cannot distinguish two recipients at the same domain', () => {
      // The point of domain-only: no durable handle on an individual.
      expect(recipientDomain('a@x.com')).toBe(recipientDomain('b@x.com'))
      expect(recipientDomain('A@X.com')).toBe('x.com')
      expect(recipientDomain('malformed')).toBe('unknown')
    })

    it('counts accepted/rejected instead of copying the address arrays', () => {
      const out = describeSendSuccess('verification', 'ada@example.com', {
        messageId: '<abc@backenly>', accepted: ['ada@example.com'], rejected: [],
      })
      const line = JSON.stringify(out)
      expect(line).not.toContain('ada@example.com')
      expect(out).toMatchObject({ accepted: 1, rejected: 0, messageId: 'abc@backenly' })
    })

    it('sanitises the provider message id and drops unsafe shapes', () => {
      // Kept: it is the handle a provider's support can look up.
      expect(sanitizeMessageId('<abc123@mail.example>', 'ada@example.com')).toBe('abc123@mail.example')
      // Dropped: echoes the recipient's local part, contains whitespace, oversized, wrong type.
      expect(sanitizeMessageId('<ada.tracking@x>', 'ada@example.com')).toBeNull()
      expect(sanitizeMessageId('has space', 'a@b.com')).toBeNull()
      expect(sanitizeMessageId('x'.repeat(200), 'a@b.com')).toBeNull()
      expect(sanitizeMessageId(undefined, 'a@b.com')).toBeNull()
    })
  })

  describe('SMTP unconfigured: bearer URLs are development-only', () => {
    const BEARER = 'https://app.example.com/auth/reset-password?token=SECRET_BEARER_TOKEN'

    it('prints a marked preview in development', () => {
      const lines: string[] = []
      reportUnconfigured({
        kind: 'password_reset', email: 'ada@example.com',
        preview: { 'Reset URL': BEARER }, isDevelopment: true, logger: l => lines.push(l),
      })
      expect(lines[0]).toContain('DEV EMAIL PREVIEW')
      expect(lines[0]).toContain(BEARER) // the whole point of the local affordance
    })

    it.each(['production', 'test', 'staging'])(
      'never prints a bearer URL, token, or address outside development (%s)',
      () => {
        const lines: string[] = []
        reportUnconfigured({
          kind: 'password_reset', email: 'ada@example.com',
          preview: { 'Reset URL': BEARER }, isDevelopment: false, logger: l => lines.push(l),
        })
        const all = lines.join('\n')
        expect(all).not.toContain(BEARER)
        expect(all).not.toContain('SECRET_BEARER_TOKEN')
        expect(all).not.toContain('token=')
        expect(all).not.toContain('ada@example.com')
        expect(all).not.toContain('ada')
        expect(all).toContain('email_not_configured')
        expect(all).toContain('password_reset')
        expect(all).toContain('example.com') // domain only
      },
    )

    it.each(['verification', 'org_invite', 'account_locked', 'password_reset'])(
      'suppresses the credential for every mail kind (%s)',
      kind => {
        const lines: string[] = []
        reportUnconfigured({
          kind, email: 'ada@example.com',
          preview: { 'URL': BEARER }, isDevelopment: false, logger: l => lines.push(l),
        })
        expect(lines.join('\n')).not.toContain('SECRET_BEARER_TOKEN')
      },
    )

    it('does not throw — callers treat missing SMTP as a resolving no-op', () => {
      expect(() =>
        reportUnconfigured({
          kind: 'x', email: 'a@b.com', isDevelopment: false,
          logger: () => { throw new Error('sink down') },
        }),
      ).not.toThrow()
    })
  })

  describe('a successful send is now visible at all', () => {
    it('emits messageId and accepted count, and returns the provider result', async () => {
      const lines: string[] = []
      const info = { messageId: '<id@backenly>', accepted: ['ada@example.com'], rejected: [] }
      const out = await observeSend('password_reset', 'ada@example.com', async () => info, l => lines.push(l))
      // Transparent: the caller still receives exactly what the provider returned.
      expect(out).toBe(info)
      expect(lines[0]).toContain('"result":"sent"')
      // angle brackets are stripped by sanitizeMessageId
      expect(lines[0]).toContain('"messageId":"id@backenly"')
    })
  })

  describe('does not alter control flow', () => {
    it('logs the classified failure and rethrows the ORIGINAL error', async () => {
      const lines: string[] = []
      const original = Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' })
      await expect(
        observeSend('password_reset', 'ada@example.com', async () => { throw original }, l => lines.push(l)),
      ).rejects.toBe(original)
      // Rethrowing keeps every existing caller's fatal/non-fatal handling intact,
      // while the reason is now recorded on the way past.
      expect(lines[0]).toContain('"category":"timeout"')
    })

    it('survives a broken log sink on success', async () => {
      await expect(
        observeSend('x', 'a@b.com', async () => ({ messageId: 'm' }), () => { throw new Error('sink down') }),
      ).resolves.toMatchObject({ messageId: 'm' })
    })

    it('survives a broken log sink on failure and still rethrows', async () => {
      const boom = new Error('provider down')
      await expect(
        observeSend('x', 'a@b.com', async () => { throw boom }, () => { throw new Error('sink down') }),
      ).rejects.toBe(boom)
    })

    it('emits the same log shape regardless of recipient — no enumeration signal', async () => {
      const la: string[] = []; const lb: string[] = []
      await observeSend('reset', 'exists@x.com', async () => ({ accepted: ['exists@x.com'] }), l => la.push(l))
      await observeSend('reset', 'missing@x.com', async () => ({ accepted: ['missing@x.com'] }), l => lb.push(l))
      const shape = (line: string) => Object.keys(JSON.parse(line.replace('[email] ', ''))).sort()
      expect(shape(lb[0])).toEqual(shape(la[0]))
    })
  })
})
