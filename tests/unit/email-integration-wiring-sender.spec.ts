/**
 * Tests for Issue #609:
 * Auto-wired welcome and password-reset emails cannot send.
 *
 * Verifies, without a database:
 * 1. buildEmailIntegration never defaults to noreply@backenly.com; throws if no sender is provided or configured.
 * 2. email.send() uses defaultFrom when configured, and allows per-call from overrides.
 * 3. email_from is checked as an email address, not as an API key.
 *
 * The connect flow (store_integration_key storing email_from, the pending-sender
 * warning, the auto-wired descriptions and the .send alias) needs a real project
 * and lives in tests/integration/email-integration-wiring-sender.spec.ts.
 */

import { buildEmailIntegration } from '@/lib/services/ai-functions/integration-context'
import { validateIntegrationKeyFormat } from '@/lib/services/integrationKeyStore'
import { verifyIntegrationKey } from '@/lib/integrations/key-verification'


describe('Issue #609: Email integration sender resolution and auto-wiring', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  describe('buildEmailIntegration runtime behavior', () => {
    it('throws when from is not passed and no default sender was configured', async () => {
      const email = buildEmailIntegration('re_test_key', null, null)

      await expect(
        email.send({
          to: 'user@example.com',
          subject: 'Welcome',
          html: '<p>Welcome</p>',
        }),
      ).rejects.toThrow(/No sender email configured/)
    })

    it('uses configured defaultFrom when from is omitted in send()', async () => {
      let capturedBody: any = null
      global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string)
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'email_123' }),
        } as any
      })

      const email = buildEmailIntegration('re_test_key', null, 'team@verifieddomain.com')
      const res = await email.send({
        to: 'user@example.com',
        subject: 'Welcome',
        html: '<p>Hello</p>',
      })

      expect(res.id).toBe('email_123')
      expect(capturedBody).toMatchObject({
        from: 'team@verifieddomain.com',
        to: ['user@example.com'],
        subject: 'Welcome',
        html: '<p>Hello</p>',
      })
      expect(capturedBody.from).not.toBe('noreply@backenly.com')
    })

    it('allows explicit from to override configured defaultFrom', async () => {
      let capturedBody: any = null
      global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string)
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'email_456' }),
        } as any
      })

      const email = buildEmailIntegration('re_test_key', null, 'default@verifieddomain.com')
      await email.send({
        to: 'user@example.com',
        from: 'custom@verifieddomain.com',
        subject: 'Custom Sender',
        html: '<p>Custom</p>',
      })

      expect(capturedBody.from).toBe('custom@verifieddomain.com')
    })

    it('formats SendGrid payloads with the resolved sender', async () => {
      let capturedBody: any = null
      global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string)
        return {
          ok: true,
          status: 202,
          text: async () => '',
        } as any
      })

      const email = buildEmailIntegration(null, 'SG.test_key', 'alerts@verifieddomain.com')
      const res = await email.send({
        to: 'user@example.com',
        subject: 'SendGrid Alert',
        html: '<p>Alert</p>',
      })

      expect(res.id).toMatch(/^sg_/)
      expect(capturedBody).toMatchObject({
        personalizations: [{ to: [{ email: 'user@example.com' }] }],
        from: { email: 'alerts@verifieddomain.com' },
        subject: 'SendGrid Alert',
        content: [{ type: 'text/html', value: '<p>Alert</p>' }],
      })
    })

    it('formats SendGrid payloads with text/plain when html is omitted', async () => {
      let capturedBody: any = null
      global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string)
        return {
          ok: true,
          status: 202,
          text: async () => '',
        } as any
      })

      const email = buildEmailIntegration(null, 'SG.test_key', 'alerts@verifieddomain.com')
      const res = await email.send({
        to: 'user@example.com',
        subject: 'Text Alert',
        text: 'This is plain text.',
      })

      expect(res.id).toMatch(/^sg_/)
      expect(capturedBody).toMatchObject({
        personalizations: [{ to: [{ email: 'user@example.com' }] }],
        from: { email: 'alerts@verifieddomain.com' },
        subject: 'Text Alert',
        content: [{ type: 'text/plain', value: 'This is plain text.' }],
      })
    })
  })

  describe('key format and verification for sender email', () => {
    it('validates email_from format correctly', () => {
      expect(validateIntegrationKeyFormat('email_from', 'valid@domain.com')).toEqual({ ok: true })
      expect(validateIntegrationKeyFormat('email_from', 'invalid-email')).toMatchObject({ ok: false })
    })

    it('verifies valid email without tripping looksFabricated checks', async () => {
      const result = await verifyIntegrationKey('email_from', 'notifications@example.com')
      expect(result.status).toBe('unverifiable')
      expect(result.detail).toContain('Sender email stored')
    })

    it('rejects invalid email address in verifyIntegrationKey', async () => {
      const result = await verifyIntegrationKey('email_from', 'not-an-email')
      expect(result.status).toBe('rejected')
      expect(result.detail).toContain('not a valid email address format')
    })
  })
})
