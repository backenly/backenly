/**
 * INTEGRATION CONTEXT BUILDER
 * ============================
 * Builds the ctx.integrations object available inside AI function sandboxes.
 *
 * When a project has stored an API key for Stripe, Resend, OpenAI, Anthropic,
 * PostHog, etc., this module decrypts it server-side and wraps it in a safe,
 * typed API that generated functions can call.
 *
 * INVARIANT: every provider the platform auto-wires (see lib/ai/minimal-executor
 * `executeStoreIntegrationKey` and lib/integrations/*.executor.ts) MUST have a
 * matching runtime wrapper here. A provider that is advertised + auto-wired but
 * not built here is a "phantom integration" — every generated function that
 * calls it fails at runtime. This file is the single source of truth for the
 * ctx.integrations surface.
 *
 * Available in AI functions as:
 *   ctx.integrations.stripe.createPaymentIntent(amountCents, currency, customerId?)
 *   ctx.integrations.stripe.createCheckoutSession({ lineItems, successUrl, cancelUrl, ... })
 *   ctx.integrations.stripe.createCustomer(email, name?, metadata?)
 *   ctx.integrations.stripe.refund(paymentIntentId, amountCents?)
 *   ctx.integrations.stripe.cancelSubscription(subscriptionId)
 *   ctx.integrations.stripe.listCustomers(email?)
 *   ctx.integrations.email.send({ to, subject, html, from? })
 *   ctx.integrations.twilio.sendSms({ to, body })
 *   ctx.integrations.openai.complete(prompt, maxTokens?)
 *   ctx.integrations.openai.embed(text)
 *   ctx.integrations.anthropic.complete(prompt, maxTokens?, systemPrompt?)
 *   ctx.integrations.posthog.capture({ distinctId, event, properties? })
 *   ctx.integrations.posthog.identify({ distinctId, properties })
 *   ctx.integrations.posthog.isFeatureEnabled(flagKey, distinctId)
 *   ctx.integrations.isConnected(name)  → boolean
 */

import { getIntegrationKey } from '@/lib/services/integrationKeyStore'
import {
  INTEGRATION_PROVIDERS,
  genericRequestProviders,
  type ProviderSpec,
} from './integration-registry'

// ── Types exposed to generated functions ──────────────────────────────────────

/**
 * Universal escape hatch present on EVERY connected provider. Guarantees that a
 * provider which stores a key is never "phantom": even without a hand-written
 * typed helper, `ctx.integrations.<id>.request(...)` makes a signed call.
 */
export interface GenericIntegration {
  request(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<any>
}

export interface StripeCheckoutLineItem {
  /** An existing Stripe Price id (price_…). Use this OR priceData. */
  price?: string
  /** Inline price — use when no Stripe Price object exists. */
  priceData?: {
    currency: string
    unitAmount: number
    productName: string
    recurringInterval?: 'day' | 'week' | 'month' | 'year'
  }
  quantity: number
}

export interface StripeIntegration {
  createPaymentIntent(amountCents: number, currency: string, customerId?: string): Promise<{ id: string; clientSecret: string; status: string }>
  createCheckoutSession(opts: {
    lineItems: StripeCheckoutLineItem[]
    successUrl: string
    cancelUrl: string
    mode?: 'payment' | 'subscription'
    customerId?: string
    customerEmail?: string
    metadata?: Record<string, string>
  }): Promise<{ id: string; url: string }>
  createCustomer(email: string, name?: string, metadata?: Record<string, string>): Promise<{ id: string; email: string }>
  refund(paymentIntentId: string, amountCents?: number): Promise<{ id: string; status: string }>
  cancelSubscription(subscriptionId: string): Promise<{ id: string; status: string }>
  listCustomers(email?: string): Promise<Array<{ id: string; email: string; name: string | null }>>
  retrievePaymentIntent(paymentIntentId: string): Promise<Record<string, any>>
}

export interface EmailIntegration {
  send(opts: { to: string | string[]; subject: string; html: string; from?: string; text?: string }): Promise<{ id: string }>
}

export interface TwilioIntegration {
  sendSms(opts: { to: string; body: string }): Promise<{ sid: string; status: string }>
}

export interface OpenAIIntegration {
  complete(prompt: string, maxTokens?: number): Promise<string>
  embed(text: string): Promise<number[]>
}

export interface AnthropicIntegration {
  /** Single-turn completion. Anthropic has no embeddings API — use openai.embed for vectors. */
  complete(prompt: string, maxTokens?: number, systemPrompt?: string): Promise<string>
}

export interface PostHogIntegration {
  /** Record a product-analytics event for a user. */
  capture(opts: { distinctId: string; event: string; properties?: Record<string, any> }): Promise<{ ok: boolean }>
  /** Attach/refresh person properties on a user. */
  identify(opts: { distinctId: string; properties: Record<string, any> }): Promise<{ ok: boolean }>
  /** Evaluate a feature flag for a user. Returns false if the flag is off or unknown. */
  isFeatureEnabled(flagKey: string, distinctId: string): Promise<boolean>
}

export interface IntegrationContext {
  stripe?: StripeIntegration & Partial<GenericIntegration>
  email?: EmailIntegration
  twilio?: TwilioIntegration
  openai?: OpenAIIntegration & Partial<GenericIntegration>
  anthropic?: AnthropicIntegration & Partial<GenericIntegration>
  posthog?: PostHogIntegration
  isConnected(name: string): boolean
  /**
   * Generic-request-only providers (replicate, runway, stability, onesignal,
   * resend, sendgrid, …) live here by canonical id. Rich providers above ALSO
   * appear here so iteration over the object is complete.
   */
  [provider: string]: any
}

// ── Stripe form encoder ────────────────────────────────────────────────────────
// Stripe's API uses application/x-www-form-urlencoded with PHP-style nesting:
//   line_items[0][price]=price_x&line_items[0][quantity]=1&metadata[k]=v
// This walks arrays + objects recursively so nested params encode correctly.

function encodeStripeForm(obj: Record<string, any>): string {
  const pairs: string[] = []
  const walk = (key: string, val: any): void => {
    if (val === undefined || val === null) return
    if (Array.isArray(val)) {
      val.forEach((v, i) => walk(`${key}[${i}]`, v))
    } else if (typeof val === 'object') {
      for (const [k, v] of Object.entries(val)) walk(`${key}[${k}]`, v)
    } else {
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(val))}`)
    }
  }
  for (const [k, v] of Object.entries(obj)) walk(k, v)
  return pairs.join('&')
}

// ── Stripe wrapper ─────────────────────────────────────────────────────────────

function buildStripeIntegration(secretKey: string): StripeIntegration {
  const STRIPE_BASE = 'https://api.stripe.com/v1'
  const headers = {
    'Authorization': `Bearer ${secretKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  }

  async function stripePost(path: string, params: Record<string, any>): Promise<any> {
    const res = await fetch(`${STRIPE_BASE}${path}`, {
      method: 'POST',
      headers,
      body: encodeStripeForm(params),
      signal: AbortSignal.timeout(8000),
    })
    const data = await res.json()
    if (data.error) throw new Error(`Stripe error: ${data.error.message}`)
    return data
  }

  async function stripeGet(path: string, params?: Record<string, any>): Promise<any> {
    const qs = params ? '?' + new URLSearchParams(params as any).toString() : ''
    const res = await fetch(`${STRIPE_BASE}${path}${qs}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(8000),
    })
    const data = await res.json()
    if (data.error) throw new Error(`Stripe error: ${data.error.message}`)
    return data
  }

  return {
    async createPaymentIntent(amountCents, currency, customerId) {
      const params: Record<string, any> = { amount: amountCents, currency }
      if (customerId) params.customer = customerId
      const pi = await stripePost('/payment_intents', params)
      return { id: pi.id, clientSecret: pi.client_secret, status: pi.status }
    },

    async createCheckoutSession(opts) {
      if (!Array.isArray(opts.lineItems) || opts.lineItems.length === 0) {
        throw new Error('createCheckoutSession requires at least one lineItem')
      }
      if (!opts.successUrl || !opts.cancelUrl) {
        throw new Error('createCheckoutSession requires successUrl and cancelUrl')
      }

      // Infer mode: subscription when any line item is recurring, else payment.
      const isRecurring = opts.lineItems.some(li => li.priceData?.recurringInterval)
      const mode = opts.mode ?? (isRecurring ? 'subscription' : 'payment')

      const line_items = opts.lineItems.map((li) => {
        if (li.price) {
          return { price: li.price, quantity: li.quantity }
        }
        if (!li.priceData) {
          throw new Error('Each lineItem needs either `price` or `priceData`')
        }
        const pd = li.priceData
        const price_data: Record<string, any> = {
          currency: pd.currency,
          unit_amount: pd.unitAmount,
          product_data: { name: pd.productName },
        }
        if (pd.recurringInterval) {
          price_data.recurring = { interval: pd.recurringInterval }
        }
        return { price_data, quantity: li.quantity }
      })

      const params: Record<string, any> = {
        mode,
        line_items,
        success_url: opts.successUrl,
        cancel_url: opts.cancelUrl,
      }
      if (opts.customerId) params.customer = opts.customerId
      else if (opts.customerEmail) params.customer_email = opts.customerEmail
      if (opts.metadata) params.metadata = opts.metadata

      const session = await stripePost('/checkout/sessions', params)
      return { id: session.id, url: session.url }
    },

    async createCustomer(email, name, metadata) {
      const params: Record<string, any> = { email }
      if (name) params.name = name
      if (metadata) params.metadata = metadata
      const c = await stripePost('/customers', params)
      return { id: c.id, email: c.email }
    },

    async refund(paymentIntentId, amountCents) {
      const params: Record<string, any> = { payment_intent: paymentIntentId }
      if (amountCents) params.amount = amountCents
      const r = await stripePost('/refunds', params)
      return { id: r.id, status: r.status }
    },

    async cancelSubscription(subscriptionId) {
      const sub = await stripePost(`/subscriptions/${subscriptionId}/cancel`, {})
      return { id: sub.id, status: sub.status }
    },

    async listCustomers(email) {
      const params: Record<string, any> = { limit: 10 }
      if (email) params.email = email
      const list = await stripeGet('/customers', params)
      return (list.data || []).map((c: any) => ({ id: c.id, email: c.email, name: c.name }))
    },

    async retrievePaymentIntent(paymentIntentId) {
      return stripeGet(`/payment_intents/${paymentIntentId}`)
    },
  }
}

// ── Email wrapper (Resend-first, fallback SendGrid) ───────────────────────────

function buildEmailIntegration(resendKey: string | null, sendgridKey: string | null): EmailIntegration {
  return {
    async send({ to, subject, html, from = 'noreply@backenly.com', text }) {
      const toArr = Array.isArray(to) ? to : [to]

      if (resendKey) {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${resendKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ from, to: toArr, subject, html, text }),
          signal: AbortSignal.timeout(8000),
        })
        const data = await res.json()
        if (data.statusCode && data.statusCode >= 400) throw new Error(`Resend error: ${data.message}`)
        return { id: data.id || 'sent' }
      }

      if (sendgridKey) {
        const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${sendgridKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            personalizations: [{ to: toArr.map(e => ({ email: e })) }],
            from: { email: from },
            subject,
            content: [{ type: 'text/html', value: html }],
          }),
          signal: AbortSignal.timeout(8000),
        })
        if (!res.ok && res.status !== 202) {
          const err = await res.text()
          throw new Error(`SendGrid error: ${err}`)
        }
        return { id: `sg_${Date.now()}` }
      }

      throw new Error('No email integration connected. Add Resend or SendGrid key in Integrations.')
    },
  }
}

// ── Twilio wrapper ─────────────────────────────────────────────────────────────

function buildTwilioIntegration(accountSid: string, authToken: string, fromNumber: string): TwilioIntegration {
  return {
    async sendSms({ to, body }) {
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ To: to, From: fromNumber, Body: body }).toString(),
          signal: AbortSignal.timeout(8000),
        }
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(`Twilio error: ${err.message || err.error_message || `HTTP ${res.status}`}`)
      }
      const data = await res.json()
      return { sid: data.sid, status: data.status }
    },
  }
}

// ── OpenAI wrapper ─────────────────────────────────────────────────────────────

function buildOpenAIIntegration(apiKey: string): OpenAIIntegration {
  return {
    async complete(prompt, maxTokens = 256) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(15000),
      })
      const data = await res.json()
      if (data.error) throw new Error(`OpenAI error: ${data.error.message}`)
      return data.choices?.[0]?.message?.content || ''
    },

    async embed(text) {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
        signal: AbortSignal.timeout(10000),
      })
      const data = await res.json()
      if (data.error) throw new Error(`OpenAI error: ${data.error.message}`)
      return data.data?.[0]?.embedding || []
    },
  }
}

// ── Anthropic wrapper ──────────────────────────────────────────────────────────
// Anthropic exposes the Messages API only — there is NO embeddings endpoint.
// Functions that need vectors must use ctx.integrations.openai.embed().

function buildAnthropicIntegration(apiKey: string): AnthropicIntegration {
  return {
    async complete(prompt, maxTokens = 512, systemPrompt) {
      const body: Record<string, any> = {
        model: 'claude-3-5-haiku-20241022',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }
      if (systemPrompt) body.system = systemPrompt

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      })
      const data = await res.json()
      if (data.error) throw new Error(`Anthropic error: ${data.error.message || data.error.type}`)
      // content is an array of blocks — concatenate the text blocks.
      return (data.content || [])
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('') || ''
    },
  }
}

// ── PostHog wrapper ────────────────────────────────────────────────────────────
// Server-side product analytics: event capture, person identify, feature flags.
// Uses the project API key (phc_…), which is write-scoped and safe server-side.

function buildPostHogIntegration(apiKey: string, host: string): PostHogIntegration {
  const base = host.replace(/\/+$/, '')

  async function captureRaw(payload: Record<string, any>): Promise<{ ok: boolean }> {
    const res = await fetch(`${base}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, ...payload }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      const err = await res.text().catch(() => '')
      throw new Error(`PostHog error: HTTP ${res.status} ${err}`.trim())
    }
    return { ok: true }
  }

  return {
    async capture({ distinctId, event, properties }) {
      if (!distinctId) throw new Error('posthog.capture requires distinctId')
      if (!event) throw new Error('posthog.capture requires event')
      return captureRaw({
        event,
        distinct_id: distinctId,
        properties: properties ?? {},
        timestamp: new Date().toISOString(),
      })
    },

    async identify({ distinctId, properties }) {
      if (!distinctId) throw new Error('posthog.identify requires distinctId')
      return captureRaw({
        event: '$identify',
        distinct_id: distinctId,
        properties: { $set: properties ?? {} },
        timestamp: new Date().toISOString(),
      })
    },

    async isFeatureEnabled(flagKey, distinctId) {
      if (!flagKey || !distinctId) return false
      const res = await fetch(`${base}/decide/?v=3`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, distinct_id: distinctId }),
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) return false
      const data = await res.json().catch(() => ({} as any))
      const flag = data?.featureFlags?.[flagKey]
      // PostHog returns true | false | a variant string. Treat any non-false as on.
      return flag !== undefined && flag !== false
    },
  }
}

// ── Universal request() builder ────────────────────────────────────────────────
// Works for ANY registry provider that declares a baseUrl + buildHeaders. This is
// the anti-phantom primitive: a stored key always yields a callable surface.

function buildGenericRequest(
  spec: ProviderSpec,
  key: string,
  auxValue: string | null,
): GenericIntegration {
  const base = (spec.baseUrl ?? '').replace(/\/+$/, '')
  return {
    async request(method, path, body, headers) {
      const m = String(method || 'GET').toUpperCase()
      const url = /^https?:\/\//i.test(path) ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`

      // Merge provider auth headers with any per-call overrides.
      const finalHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(spec.buildHeaders ? spec.buildHeaders(key) : {}),
        ...(headers ?? {}),
      }

      // Inject aux fields (e.g. OneSignal app_id) into JSON bodies only.
      let finalBody = body
      if (spec.injectBody && finalBody && typeof finalBody === 'object' && !Array.isArray(finalBody)) {
        finalBody = { ...spec.injectBody(auxValue), ...(finalBody as Record<string, unknown>) }
      }

      const hasBody = finalBody !== undefined && finalBody !== null && m !== 'GET' && m !== 'HEAD'

      const res = await fetch(url, {
        method: m,
        headers: finalHeaders,
        body: hasBody
          ? (typeof finalBody === 'string' ? finalBody : JSON.stringify(finalBody))
          : undefined,
        signal: AbortSignal.timeout(20000),
      })

      const text = await res.text()
      let data: any
      try { data = text ? JSON.parse(text) : null } catch { data = text }

      if (!res.ok) {
        const detail = typeof data === 'string' ? data : JSON.stringify(data)
        throw new Error(`${spec.displayName} API ${res.status}: ${detail?.slice?.(0, 500) ?? detail}`)
      }
      return data
    },
  }
}

// ── Main builder ───────────────────────────────────────────────────────────────

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com'

/**
 * Build the ctx.integrations object for a given project.
 * Only includes integrations that have stored keys — safe to call for every function.
 */
export async function buildIntegrationContext(projectId: string): Promise<IntegrationContext> {
  const connected = new Set<string>()

  // Load all integration keys in parallel
  const [stripeKey, resendKey, sendgridKey, openaiKey, anthropicKey, twilioRaw, posthogKey, posthogHost] =
    await Promise.all([
      getIntegrationKey(projectId, 'stripe').catch(() => null),
      getIntegrationKey(projectId, 'resend').catch(() => null),
      getIntegrationKey(projectId, 'sendgrid').catch(() => null),
      getIntegrationKey(projectId, 'openai').catch(() => null),
      getIntegrationKey(projectId, 'anthropic').catch(() => null),
      getIntegrationKey(projectId, 'twilio').catch(() => null),
      getIntegrationKey(projectId, 'posthog').catch(() => null),
      getIntegrationKey(projectId, 'posthog_host').catch(() => null),
    ])

  const ctx: IntegrationContext = {
    isConnected(name: string) {
      return connected.has(name.toLowerCase())
    },
  }

  if (stripeKey) {
    ctx.stripe = buildStripeIntegration(stripeKey)
    connected.add('stripe')
  }

  if (resendKey || sendgridKey) {
    ctx.email = buildEmailIntegration(resendKey, sendgridKey)
    connected.add('email')
    if (resendKey) connected.add('resend')
    if (sendgridKey) connected.add('sendgrid')
  }

  if (openaiKey) {
    ctx.openai = buildOpenAIIntegration(openaiKey)
    connected.add('openai')
  }

  if (anthropicKey) {
    ctx.anthropic = buildAnthropicIntegration(anthropicKey)
    connected.add('anthropic')
  }

  if (twilioRaw) {
    // Twilio key stored as "accountSid:authToken:fromNumber"
    const parts = twilioRaw.split(':')
    if (parts.length >= 3) {
      ctx.twilio = buildTwilioIntegration(parts[0], parts[1], parts[2])
      connected.add('twilio')
      connected.add('sms')
    }
  }

  if (posthogKey) {
    ctx.posthog = buildPostHogIntegration(posthogKey, posthogHost || DEFAULT_POSTHOG_HOST)
    connected.add('posthog')
  }

  // ── Universal request() for every connected provider ─────────────────────────
  // Registry-driven: any provider with a baseUrl + auth gets a .request() helper.
  // This is what makes Replicate/Runway/Stability/OneSignal (and any future
  // provider) work in generated functions — no per-provider wiring needed.
  await Promise.all(
    genericRequestProviders().map(async (spec) => {
      // First stored key wins across the provider's vault ids.
      let key: string | null = null
      for (const kid of spec.keyStoreIds) {
        key = await getIntegrationKey(projectId, kid).catch(() => null)
        if (key) break
      }
      if (!key) return

      const auxValue = spec.auxKeyStoreId
        ? await getIntegrationKey(projectId, spec.auxKeyStoreId).catch(() => null)
        : null

      const generic = buildGenericRequest(spec, key, auxValue)

      if (ctx[spec.id] && typeof ctx[spec.id] === 'object') {
        // Rich provider already built (stripe/openai/anthropic) — add request() as
        // an escape hatch alongside the typed helpers.
        if (typeof (ctx[spec.id] as any).request !== 'function') {
          ;(ctx[spec.id] as any).request = generic.request
        }
      } else {
        ctx[spec.id] = generic
      }

      // Register every alias so isConnected('kling' / 'claude' / 'sms') works.
      for (const name of spec.connectedNames) connected.add(name.toLowerCase())
      connected.add(spec.id.toLowerCase())
    }),
  )

  return ctx
}

/**
 * Return a human-readable summary of which integrations are connected.
 * Used by the generator to include in the function prompt.
 */
/**
 * Canonical provider ids that have a stored key on this project (registry-driven).
 * Includes the 'email' pseudo-provider AND the concrete resend/sendgrid ids, so
 * both ctx.integrations.email.send and ctx.integrations.resend.request are
 * documented. Used by the function generator to render the ctx.integrations docs.
 */
export async function getConnectedProviderIds(projectId: string): Promise<string[]> {
  const specs = Object.values(INTEGRATION_PROVIDERS)
  const results = await Promise.all(
    specs.map(async (spec) => {
      for (const kid of spec.keyStoreIds) {
        const key = await getIntegrationKey(projectId, kid).catch(() => null)
        if (key) return spec.id
      }
      return null
    }),
  )
  return results.filter((id): id is string => !!id)
}

export async function getConnectedIntegrationNames(projectId: string): Promise<string[]> {
  // Registry-driven so EVERY provider (incl. replicate/runway/stability/onesignal)
  // is reported — the old hardcoded list is what made them phantom to the generator.
  // Skip the 'email' pseudo-provider: resend/sendgrid report themselves.
  const specs = Object.values(INTEGRATION_PROVIDERS).filter((s) => s.id !== 'email')

  const results = await Promise.all(
    specs.map(async (spec) => {
      for (const kid of spec.keyStoreIds) {
        const key = await getIntegrationKey(projectId, kid).catch(() => null)
        if (key) return spec
      }
      return null
    }),
  )

  const CATEGORY_HINT: Record<string, string> = {
    email: 'email',
    sms: 'SMS',
    analytics: 'analytics',
    video: 'generative AI',
    push: 'push',
  }

  const names: string[] = []
  for (const spec of results) {
    if (!spec) continue
    const hint = CATEGORY_HINT[spec.category]
    names.push(hint ? `${spec.id} (${hint})` : spec.id)
  }
  return names
}
