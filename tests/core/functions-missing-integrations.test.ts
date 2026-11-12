/**
 * A FUNCTION THAT USES AN INTEGRATION NOBODY CONNECTED IS REPORTED
 * ================================================================
 * Production QA (2026-11-09), Integrations: the shipping-email function ran on
 * every order update and logged "NOT SENT: no email provider connected".
 * Overview and readiness stayed green, and the deploy that put it there said
 * nothing. Nothing compared what a function's code uses through
 * ctx.integrations with what the project has connected.
 *
 * Now the observer records one finding per such function, the reaper withdraws
 * it once the provider is connected, and the deploy answer says it at once.
 * Real PostgreSQL, the real observer and the real deploy action.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'
import { integrationsUsedBy, missingIntegrations } from '@/lib/services/ai-functions/integration-use'
import { detectFunctionsMissingIntegrations } from '@/lib/autonomy/function-integrations'
import { runObserverForProject } from '@/lib/services/workspace-observer'
import { gapIdentity } from '@/lib/autonomy/desired-state'
import { reapObserverFindings } from '@/lib/core/finding-reaper'
import { classifyFix } from '@/lib/core/fix-classifier'
import { getManualRemediationHint } from '@/lib/core/fix-actions'
import { summariseFinding } from '@/lib/core/finding-summaries'
import { categoryOf } from '@/lib/core/finding-groups'
import { deployFunctionCode } from '@/lib/services/ai-functions/agent-actions'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'

const prisma = new PrismaClient()
const userId = randomUUID()
const projectId = randomUUID()
const neighbourId = randomUUID()
const schema = `workspace_${projectId}`
const raw = (sql: string) => prisma.$executeRawUnsafe(sql)
const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
const fns: Record<string, string> = {}

/** The function production QA watched, as the agent wrote it. */
const SHIPPING_EMAIL = `
const order = event.record
if (order.status !== 'shipped') return { skipped: true }
if (!ctx.integrations.email) {
  ctx.log('NOT SENT: no email provider connected')
  return { sent: false }
}
await ctx.integrations.email.send({ to: order.email, subject: 'Your order has shipped', html: '<p>It is on its way.</p>' })
return { sent: true }
`

const used = (code: string) => integrationsUsedBy(code)
const EMAIL = { category: 'email', uses: ['email'], connect: ['resend', 'sendgrid'], connectLabel: 'Resend or SendGrid' }

async function fn(name: string, code: string, opts: { triggerType?: string; triggerTable?: string; status?: string; project?: string } = {}) {
  const row = await prisma.aiFunction.create({
    data: {
      projectId: opts.project ?? projectId, name, description: `${name} (test)`, generatedCode: code, codeOrigin: 'agent',
      triggerType: opts.triggerType ?? 'manual', triggerTable: opts.triggerTable ?? null, status: opts.status ?? 'active',
    },
  })
  fns[name] = row.id
}

const connect = (integrationId: string, project = projectId) =>
  prisma.projectIntegrationKey.create({ data: { projectId: project, integrationId, encryptedKey: 'not-a-real-key', maskedKey: '****' } })

const openFor = (name: string) =>
  prisma.healthFinding.findMany({
    where: {
      projectId, type: 'function_integration_missing', status: { in: ['open', 'pending_approval'] },
      details: { path: ['functionId'], equals: fns[name] },
    },
  })

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  resetSingleTenantCache()
  await prisma.user.create({ data: { id: userId, email: `fn-integrations+${userId.slice(0, 8)}@backenly.test`, name: 'fn', password: 'x' } })
  await prisma.project.create({ data: { id: projectId, name: 'functions-missing-integrations', userId, jwtSecret: 'a'.repeat(64) } })
  await prisma.project.create({ data: { id: neighbourId, name: 'functions-missing-integrations-neighbour', userId, jwtSecret: 'b'.repeat(64) } })
  // A registered table is what makes a project watchable by the observer.
  await prisma.table.create({ data: { name: 'orders', projectId } })
  await raw(`CREATE SCHEMA "${schema}"`)
  await raw(`CREATE TABLE "${schema}".orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, status text)`)

  await fn('send-shipping-email', SHIPPING_EMAIL, { triggerType: 'on_db_update', triggerTable: 'orders' })
  await fn('welcome-text', `await ctx.integrations.twilio.sendSms({ to: event.user.phone, body: 'Welcome' })`, { triggerType: 'on_signup' })
  // Stripe is connected: nothing to report.
  await fn('charge-order', `return ctx.integrations.stripe.createPaymentIntent(event.total, 'usd')`)
  await connect('stripe')
  // Switched off: it runs nothing.
  await fn('old-digest', `await ctx.integrations.email.send({ to: 'x', subject: 'y', html: 'z' })`, { status: 'inactive' })
  // Another project's function, and nothing connected there either.
  await fn('elsewhere', SHIPPING_EMAIL, { project: neighbourId })
}, 60_000)

afterAll(async () => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  resetSingleTenantCache()
  await raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  for (const id of [projectId, neighbourId]) {
    await prisma.healthFinding.deleteMany({ where: { projectId: id } }).catch(() => {})
    await prisma.projectIntegrationKey.deleteMany({ where: { projectId: id } }).catch(() => {})
    await prisma.aiFunction.deleteMany({ where: { projectId: id } }).catch(() => {})
    await prisma.table.deleteMany({ where: { projectId: id } }).catch(() => {})
  }
  await prisma.project.deleteMany({ where: { id: { in: [projectId, neighbourId] } } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
  await prisma.$disconnect()
}, 60_000)

describe('what a function uses through ctx.integrations', () => {
  test('the shipping email function uses email', () => {
    expect(used(SHIPPING_EMAIL)).toEqual([{ name: 'email', provider: 'email' }])
  })

  test('every way code reaches a provider', () => {
    const code = `
      const { integrations } = ctx
      const { openai, claude: ai } = ctx.integrations
      const url = 'https://api.example.com//v1'; await ctx.integrations?.stripe?.refund(event.id)
      await ctx.integrations['twilio'].sendSms({ to: '1', body: '2' })
      if (ctx.integrations.isConnected("posthog")) await integrations.onesignal.request('POST', '/notifications', {})
    `
    expect(used(code).map((u) => `${u.name}:${u.provider}`).sort()).toEqual(
      ['claude:anthropic', 'onesignal:onesignal', 'openai:openai', 'posthog:posthog', 'stripe:stripe', 'twilio:twilio'],
    )
  })

  test('comments, other objects and unknown names are not uses', () => {
    const code = `
      // await ctx.integrations.stripe.refund(event.id)
      /* ctx.integrations.twilio.sendSms() */
      const cfg = settings.integrations.sendgrid
      await ctx.integrations.hubspot.request('GET', '/contacts')
      return ctx.integrations.isConnected
    `
    expect(used(code)).toEqual([])
  })
})

describe('what it cannot reach', () => {
  test('email with no email provider', () => {
    expect(missingIntegrations(used(SHIPPING_EMAIL), new Set())).toEqual([EMAIL])
  })

  test('either email provider serves ctx.integrations.email', () => {
    expect(missingIntegrations(used(SHIPPING_EMAIL), new Set(['sendgrid']))).toEqual([])
  })

  test('code that takes whichever provider is connected is not reported', () => {
    expect(missingIntegrations(used('const mail = ctx.integrations.resend ?? ctx.integrations.sendgrid'), new Set(['sendgrid']))).toEqual([])
  })

  test('a named provider needs that provider', () => {
    expect(missingIntegrations(used(`ctx.integrations.resend.request('GET', '/domains')`), new Set(['sendgrid']))).toEqual([
      { category: 'email', uses: ['resend'], connect: ['resend'], connectLabel: 'Resend' },
    ])
  })

  test('each kind is its own entry, and an alias names its provider', () => {
    const code = `await ctx.integrations.stripe.refund(id); await ctx.integrations.email.send({}); await ctx.integrations.claude.complete('hi')`
    expect(missingIntegrations(used(code), new Set())).toEqual([
      { category: 'payments', uses: ['stripe'], connect: ['stripe'], connectLabel: 'Stripe' },
      EMAIL,
      { category: 'ai', uses: ['claude'], connect: ['anthropic'], connectLabel: 'Anthropic Claude' },
    ])
  })
})

describe('the loop', () => {
  test('reports each active function that uses an unconnected integration, and only those', async () => {
    const findings = await detectFunctionsMissingIntegrations(projectId)
    expect(findings.map((f) => f.details.functionName)).toEqual(['send-shipping-email', 'welcome-text'])
    expect(findings[0]).toEqual({
      type: 'function_integration_missing',
      severity: 'warning',
      autoFixable: false,
      details: {
        functionId: fns['send-shipping-email'],
        functionName: 'send-shipping-email',
        trigger: 'on_db_update',
        tableName: 'orders',
        missing: [EMAIL],
      },
    })
    expect(findings[1].details).not.toHaveProperty('tableName')
  })

  test('the observer records them, waiting on a person, one row per function', async () => {
    await runObserverForProject(projectId)
    const shipping = await openFor('send-shipping-email')
    expect(shipping).toHaveLength(1)
    expect(shipping[0].status).toBe('pending_approval')
    expect(await openFor('welcome-text')).toHaveLength(1)
    expect(await openFor('charge-order')).toHaveLength(0)
    expect(await openFor('old-digest')).toHaveLength(0)
    await runObserverForProject(projectId)
    expect(await openFor('send-shipping-email')).toHaveLength(1)
  }, 120_000)

  test('connecting Resend withdraws the email function and keeps the other', async () => {
    await connect('resend')
    const now = await detectFunctionsMissingIntegrations(projectId)
    expect(now.map((f) => f.details.functionName)).toEqual(['welcome-text'])
    await reapObserverFindings(projectId, new Set(now.map((f) => gapIdentity(f.type, f.details))), true)
    expect(await openFor('send-shipping-email')).toHaveLength(0)
    expect(await openFor('welcome-text')).toHaveLength(1)
  }, 120_000)
})

describe('what a person reads', () => {
  const finding = (missing: unknown[], extra: Record<string, unknown> = {}) => ({
    functionId: 'f1', functionName: 'send-shipping-email', trigger: 'on_db_update', tableName: 'orders', missing, ...extra,
  })
  const PAYMENTS = { category: 'payments', uses: ['stripe'], connect: ['stripe'], connectLabel: 'Stripe' }

  test('the loop only tells, under Reliability', () => {
    expect(classifyFix('function_integration_missing', finding([EMAIL])).decision).toBe('notify_only')
    expect(categoryOf({ type: 'function_integration_missing', details: finding([EMAIL]) })).toBe('reliability')
  })

  test('the line says which function and what is not connected', () => {
    expect(summariseFinding('function_integration_missing', finding([EMAIL]))).toBe(
      '`send-shipping-email` uses Resend or SendGrid, and neither is connected',
    )
    expect(summariseFinding('function_integration_missing', finding([PAYMENTS], { functionName: 'charge-order' }))).toBe(
      "`charge-order` uses Stripe, which isn't connected",
    )
    expect(summariseFinding('function_integration_missing', finding([PAYMENTS, EMAIL], { functionName: 'charge-and-notify' }))).toBe(
      "`charge-and-notify` uses 2 integrations that aren't connected: Stripe, and Resend or SendGrid",
    )
  })

  test('the hint says which calls have nothing behind them, and both ways out', () => {
    expect(getManualRemediationHint('function_integration_missing', finding([EMAIL]))).toBe(
      'send-shipping-email runs when a row in orders changes. Its code uses ctx.integrations.email, which is undefined ' +
        'on this project because no Resend or SendGrid key is connected, so that part of send-shipping-email isn\'t working.' +
        '\n\nConnect Resend or SendGrid on the Integrations page, or ask your coding agent to change send-shipping-email ' +
        'so it doesn\'t need it. This clears once one is connected or send-shipping-email no longer uses it.',
    )
    expect(
      getManualRemediationHint(
        'function_integration_missing',
        finding([PAYMENTS, EMAIL], { functionName: 'charge-and-notify', trigger: 'manual', tableName: undefined }),
      ),
    ).toBe(
      'charge-and-notify runs when it is called. Its code uses ctx.integrations.stripe and ctx.integrations.email, which ' +
        'are undefined on this project because no Stripe key and no Resend or SendGrid key are connected, so those parts ' +
        "of charge-and-notify aren't working.\n\nConnect Stripe, and Resend or SendGrid, on the Integrations page, or ask " +
        "your coding agent to change charge-and-notify so it doesn't need them. This clears once they are connected or " +
        'charge-and-notify no longer uses them.',
    )
  })
})

describe('the deploy answer', () => {
  test('says what the code uses that the project has not connected', async () => {
    const out = await deployFunctionCode(
      { userId, projectId },
      { name: 'summarise-order', trigger: 'manual', code: `return ctx.integrations.openai.complete('Summarise ' + event.id)` },
    )
    expect(out.ok).toBe(true)
    expect(out.summary).toContain(
      'Its code uses ctx.integrations.openai, and this project has no OpenAI key, so those calls ' +
        'can\'t work until it is connected with integrations { action: "connect" }.',
    )
    expect((out.data as any).missingIntegrations).toEqual([
      { category: 'ai', uses: ['openai'], connect: ['openai'], connectLabel: 'OpenAI' },
    ])
  }, 60_000)

  test('says nothing when everything it uses is connected', async () => {
    const out = await deployFunctionCode(
      { userId, projectId },
      { name: 'refund-order', trigger: 'manual', code: `return ctx.integrations.stripe.refund(event.paymentIntentId)` },
    )
    expect(out.ok).toBe(true)
    expect(out.summary).not.toContain('ctx.integrations')
    expect((out.data as any).missingIntegrations).toEqual([])
  }, 60_000)
})
