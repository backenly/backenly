/**
 * Tests for Issue #609:
 * Auto-wired welcome and password-reset emails cannot send.
 *
 * Verifies:
 * 1. Auto-wired descriptions prompt for ctx.integrations.email.send(), not .resend.send() or .sendgrid.send().
 * 2. buildEmailIntegration never defaults to noreply@backenly.com; throws if no sender is provided or configured.
 * 3. email.send() uses defaultFrom when configured, and allows per-call from overrides.
 * 4. Resend and SendGrid integrations have defensive .send alias to ctx.email.send.
 * 5. store_integration_key accepts fromEmail, stores email_from, and warns when sender is pending.
 */

import { buildEmailIntegration } from '@/lib/services/ai-functions/integration-context'
import { validateIntegrationKeyFormat } from '@/lib/services/integrationKeyStore'
import { verifyIntegrationKey } from '@/lib/integrations/key-verification'
import { executeAction } from '@/lib/ai/minimal-executor'
import { TOOL_TO_ACTION } from '@/lib/ai/brain/tools'
import { prisma } from '@/lib/db/prisma'
import crypto from 'crypto'

jest.mock('@/lib/services/ai-functions/generator', () => {
  const actual = jest.requireActual('@/lib/services/ai-functions/generator')
  let n = 0
  return {
    ...actual,
    generateFunctionCode: jest.fn(async () => ({
      name: `generated-fn-${++n}`,
      code: 'return { handled: true }',
    })),
    generateFixedFunctionCode: jest.fn(async () => null),
  }
})

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

  describe('store_integration_key action and auto-wiring', () => {
    let ownerId: string
    let projectId: string

    beforeAll(async () => {
      // Mock fetch so Resend key validation succeeds
      global.fetch = jest.fn(async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url.toString()
        if (u.includes('resend.com')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [] }),
            text: async () => JSON.stringify({ data: [] }),
          } as any
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => '{}',
        } as any
      })

      ownerId = (
        await prisma.user.create({
          data: {
            email: `email-wiring-${crypto.randomBytes(6).toString('hex')}@example.test`,
            password: 'not-a-real-hash',
          },
        })
      ).id

      projectId = (
        await prisma.project.create({
          data: {
            name: 'Email Wiring Project',
            userId: ownerId,
          },
        })
      ).id
    }, 60_000)

    afterAll(async () => {
      global.fetch = originalFetch
      await prisma.projectIntegrationKey.deleteMany({ where: { projectId } }).catch(() => {})
      await prisma.aiFunction.deleteMany({ where: { projectId } }).catch(() => {})
      await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
      await prisma.project.update({ where: { id: projectId }, data: { activeGraphId: null } }).catch(() => {})
      await prisma.backendGraph.deleteMany({ where: { projectId } }).catch(() => {})
      await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
      await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
    })

    it('prompts for both API key and fromEmail when apiKey is missing', async () => {
      const mapped = TOOL_TO_ACTION.store_integration_key({
        integrationId: 'resend',
      })
      const result = await executeAction(mapped, projectId, undefined, 0, undefined, false)

      expect(result.success).toBe(false)
      expect(result.error).toBe('CREDENTIALS_PENDING')
      expect(result.message).toContain('fromEmail')
    })

    it('flags senderEmailPending when connecting without fromEmail', async () => {
      const mapped = TOOL_TO_ACTION.store_integration_key({
        integrationId: 'resend',
        apiKey: 're_live_resend_vault_key_1234567890abcdef',
      })
      const result = await executeAction(mapped, projectId, undefined, 0, undefined, false)

      expect(result.success).toBe(true)
      expect((result.data as any).senderEmailPending).toBe(true)
      expect(result.message).toContain('Default sender email is NOT set')
    })

    it('stores email_from and clears senderEmailPending when fromEmail is supplied', async () => {
      const mapped = TOOL_TO_ACTION.store_integration_key({
        integrationId: 'resend',
        apiKey: 're_live_resend_vault_key_1234567890abcdef',
        fromEmail: 'welcome@myapp.com',
      })
      const result = await executeAction(mapped, projectId, undefined, 0, undefined, false)

      expect(result.success).toBe(true)
      expect((result.data as any).senderEmailPending).toBe(false)
      expect((result.data as any).fromEmail).toBe('welcome@myapp.com')
      expect(result.message).toContain('Default sender email: `welcome@myapp.com`')

      const storedSender = await prisma.projectIntegrationKey.findUnique({
        where: { projectId_integrationId: { projectId, integrationId: 'email_from' } },
      })
      expect(storedSender).not.toBeNull()
    })

    it('generates auto-wired functions with descriptions calling ctx.integrations.email.send()', async () => {
      // Create reset table so both welcome and reset functions get auto-wired
      await prisma.table.create({
        data: {
          projectId,
          name: 'password_reset',
        },
      })

      // Enable email auth on graph pointer
      const graph = await prisma.backendGraph.create({
        data: {
          projectId,
          graphData: {
            auth: { providers: { email: { enabled: true } } },
          },
        },
        select: { id: true },
      })
      await prisma.project.update({
        where: { id: projectId },
        data: { activeGraphId: graph.id },
      })

      const engineMode = process.env.ENGINE_MODE
      delete process.env.ENGINE_MODE

      try {
        const mapped = TOOL_TO_ACTION.store_integration_key({
          integrationId: 'resend',
          apiKey: 're_live_resend_vault_key_1234567890abcdef',
          fromEmail: 'welcome@myapp.com',
        })
        const result = await executeAction(mapped, projectId, undefined, 0, undefined, false)
        expect(result.success).toBe(true)

        const welcomeFn = await prisma.aiFunction.findFirst({
          where: { projectId, name: 'resend-welcome-email' },
        })
        expect(welcomeFn).not.toBeNull()
        expect(welcomeFn!.description).toContain('ctx.integrations.email.send()')
        expect(welcomeFn!.description).not.toContain('ctx.integrations.resend.send()')

        const resetFn = await prisma.aiFunction.findFirst({
          where: { projectId, name: 'resend-password-reset-email' },
        })
        expect(resetFn).not.toBeNull()
        expect(resetFn!.description).toContain('ctx.integrations.email.send()')
        expect(resetFn!.description).not.toContain('ctx.integrations.resend.send()')
      } finally {
        if (engineMode !== undefined) process.env.ENGINE_MODE = engineMode
      }
    }, 60_000)

    it('defensively aliases .send on ctx.resend to ctx.email.send', async () => {
      const { buildIntegrationContext } = await import('@/lib/services/ai-functions/integration-context')
      const ctx = await buildIntegrationContext(projectId)
      expect(typeof ctx.email?.send).toBe('function')
      expect(typeof (ctx.resend as any)?.send).toBe('function')
      expect((ctx.resend as any)?.send).toBe(ctx.email?.send)
    })
  })
})
