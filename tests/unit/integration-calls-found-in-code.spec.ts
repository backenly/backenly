/**
 * "Called from" (Integrations) and "Calls ctx.integrations.email" (a
 * function's Code view) are read from the stored code, the way the runtime
 * names providers (lib/services/ai-functions/integration-context.ts):
 * a provider's id, an alias, or `email`, which sends through Resend or
 * SendGrid. Pure functions, no database.
 */
import {
  accessorsFor,
  functionsCalling,
  functionsWaitingOn,
  integrationAccessors,
  providersCalledIn,
  providersForAccessor,
} from '@/components/hub/integration-calls'

const WELCOME = `const { id } = await ctx.integrations.email.send({ to: user.email, from: ctx.env.MAIL_FROM })
if (!ctx.integrations.isConnected('stripe')) return
await ctx.integrations.email.send({ to: 'x' })`
const PUSH = `await ctx.integrations.onesignal.request('POST', '/notifications', {})`
const BRACKETED = `await ctx.integrations['claude'].complete('hi')`

it('lists each accessor once, first seen first, and never isConnected', () => {
  expect(integrationAccessors(WELCOME)).toEqual(['email'])
  expect(integrationAccessors(`${PUSH}\n${WELCOME}`)).toEqual(['onesignal', 'email'])
  expect(integrationAccessors(BRACKETED)).toEqual(['claude'])
  expect(integrationAccessors(null)).toEqual([])
  expect(integrationAccessors('const integrations = ctx.db')).toEqual([])
})

it('maps an accessor to the providers it reaches', () => {
  expect(providersForAccessor('email')).toEqual(['resend', 'sendgrid'])
  expect(providersForAccessor('resend')).toEqual(['resend'])
  expect(providersForAccessor('claude')).toEqual(['anthropic'])
  expect(providersForAccessor('sms')).toEqual(['twilio'])
  expect(providersForAccessor('push')).toEqual(['onesignal'])
  expect(providersForAccessor('nope')).toEqual([])
})

it('finds the functions that call a provider', () => {
  const fns = [
    { name: 'send-welcome-email', generatedCode: WELCOME },
    { name: 'on-review-created', generatedCode: PUSH },
    { name: 'recommend-movies', generatedCode: 'return ctx.db.query("movies")' },
    { name: 'no-code', generatedCode: null },
  ]
  expect(functionsCalling('resend', fns).map((f) => f.name)).toEqual(['send-welcome-email'])
  expect(functionsCalling('sendgrid', fns).map((f) => f.name)).toEqual(['send-welcome-email'])
  expect(functionsCalling('onesignal', fns).map((f) => f.name)).toEqual(['on-review-created'])
  expect(functionsCalling('stripe', fns)).toEqual([])
  expect(providersCalledIn(`${WELCOME}\n${PUSH}`)).toEqual(['resend', 'sendgrid', 'onesignal'])
  expect(accessorsFor('resend', WELCOME)).toEqual(['email'])
})

it('says a call waits on a provider only when nothing connected serves it', () => {
  const fns = [
    { name: 'send-welcome-email', generatedCode: WELCOME },
    { name: 'on-review-created', generatedCode: PUSH },
  ]
  // Resend serves ctx.integrations.email, so nothing waits on SendGrid.
  expect(functionsWaitingOn('sendgrid', fns, ['resend'])).toEqual([])
  expect(functionsWaitingOn('sendgrid', fns, []).map((f) => f.name)).toEqual(['send-welcome-email'])
  expect(functionsWaitingOn('onesignal', fns, ['resend']).map((f) => f.name)).toEqual(['on-review-created'])
})
