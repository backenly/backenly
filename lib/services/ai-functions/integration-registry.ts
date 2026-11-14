/**
 * INTEGRATION PROVIDER REGISTRY
 * =============================
 * THE single source of truth for every third-party provider Backenly can wire
 * into a project. Adding a provider here — and ONLY here — makes it work across
 * every layer automatically:
 *
 *   • integration-context.ts  builds ctx.integrations.<id> (typed methods +
 *                             the universal .request() escape hatch)
 *   • executor.ts             forwards every method to the sandbox generically
 *   • isolation/function-runner.cjs  exposes the methods to generated function code
 *   • generator.ts            documents the surface in the codegen prompt
 *   • getConnectedIntegrationNames  lists it to the brain + generator
 *
 * This kills the "phantom integration" class of bug: a provider that stores a
 * key and is advertised, but has no runtime surface, so every generated function
 * that calls it fails. If a provider is in this registry with a baseUrl + auth,
 * `ctx.integrations.<id>.request(method, path, body?, headers?)` ALWAYS works.
 *
 * Rich providers (stripe, email, openai, anthropic, posthog, twilio) additionally
 * get hand-written typed helpers whose implementations live in
 * integration-context.ts. Those helper NAMES are declared here (in `methods`)
 * purely so the generator can document them and the manifest is complete — the
 * implementations are not duplicated.
 */

import { AI_HELPER_DEFAULTS } from './model-defaults'

const OPENAI_DEFAULTS = AI_HELPER_DEFAULTS.openai
const ANTHROPIC_DEFAULTS = AI_HELPER_DEFAULTS.anthropic.complete

export type IntegrationCategory =
  | 'payments'
  | 'email'
  | 'ai'
  | 'sms'
  | 'analytics'
  | 'video'
  | 'push'
  | 'other'

export interface ProviderMethodDoc {
  /** Method name on ctx.integrations.<id>.<name> */
  name: string
  /** One-line signature + return shape, shown to the codegen model. */
  signature: string
}

export interface ProviderSpec {
  /** Canonical id — matches the integrationKeyStore id and the ctx.integrations key. */
  id: string
  displayName: string
  category: IntegrationCategory
  /**
   * All names that should resolve `true` in ctx.integrations.isConnected(name).
   * e.g. the email provider answers to 'email', 'resend', and 'sendgrid'.
   */
  connectedNames: string[]
  /**
   * Key-vault ids that hold this provider's secret. The FIRST one found (in order)
   * is used as the credential. e.g. email → ['resend', 'sendgrid'].
   */
  keyStoreIds: string[]
  /** Base URL for the universal request() helper. Omit for providers with no simple REST base (e.g. posthog). */
  baseUrl?: string
  /** Build the auth + version headers for request() from the decrypted key. */
  buildHeaders?: (key: string) => Record<string, string>
  /**
   * Optional secondary credential (e.g. OneSignal App ID) fetched from the vault
   * and merged into every request() JSON body via `injectBody`.
   */
  auxKeyStoreId?: string
  /** Merge these fields into every request() body (used for app_id-style params). */
  injectBody?: (auxValue: string | null) => Record<string, unknown>
  /**
   * How request() sends an object body when the call names no Content-Type:
   * 'json' (the default), 'form' (application/x-www-form-urlencoded, nested as
   * metadata[key] and items[0][price]) or 'multipart' (multipart/form-data).
   */
  bodyEncoding?: 'json' | 'form' | 'multipart'
  /** True when integration-context.ts attaches hand-written typed helpers for this id. */
  rich?: boolean
  /** Whether to expose the universal .request() helper. Default true when baseUrl is set. */
  genericRequest?: boolean
  /** Documented method surface (typed helpers + 'request') for the codegen prompt. */
  methods: ProviderMethodDoc[]
  keyFormat?: string
  docsUrl?: string
}

// The example used to be '/v1/x', relative to bases that already end in /v1,
// so a path written as the example (or as the provider documents it) was sent
// to /v1/v1/x. request() now sends a repeated version once, and the doc says
// what a path is relative to: the base renderIntegrationDocs prints beside it.
const REQUEST_DOC: ProviderMethodDoc = {
  name: 'request',
  signature:
    "request(method, path, body?, headers?) → parsed JSON — signed call to the provider's API. " +
    "path is relative to the provider's request() base; one that repeats the base's version, as the provider's docs write it, is sent once. " +
    'An absolute URL must stay on the provider\'s host. An object body is sent as JSON unless headers name ' +
    "Content-Type 'application/x-www-form-urlencoded' or 'multipart/form-data' (a multipart file field is { base64, filename?, contentType? }). " +
    'Auth headers are injected automatically; never put the key in code.',
}

/** REQUEST_DOC with a provider's own note after it. */
function requestDoc(note: string): ProviderMethodDoc {
  return { name: 'request', signature: `${REQUEST_DOC.signature} ${note}` }
}

// ── Registry ────────────────────────────────────────────────────────────────

export const INTEGRATION_PROVIDERS: Record<string, ProviderSpec> = {
  // ── Payments ──────────────────────────────────────────────────────────────
  stripe: {
    id: 'stripe',
    displayName: 'Stripe',
    category: 'payments',
    connectedNames: ['stripe'],
    keyStoreIds: ['stripe'],
    baseUrl: 'https://api.stripe.com/v1',
    buildHeaders: (k) => ({ Authorization: `Bearer ${k}` }),
    // Stripe's REST API takes form-encoded bodies, never JSON.
    bodyEncoding: 'form',
    rich: true,
    genericRequest: true,
    keyFormat: 'sk_live_… / sk_test_…',
    docsUrl: 'https://stripe.com/docs/api',
    methods: [
      { name: 'createPaymentIntent', signature: 'createPaymentIntent(amountCents, currency, customerId?) → { id, clientSecret, status }' },
      { name: 'createCheckoutSession', signature: 'createCheckoutSession({ lineItems, successUrl, cancelUrl, mode?, customerId?, customerEmail?, metadata? }) → { id, url }' },
      { name: 'createCustomer', signature: 'createCustomer(email, name?, metadata?) → { id, email }' },
      { name: 'refund', signature: 'refund(paymentIntentId, amountCents?) → { id, status }' },
      { name: 'cancelSubscription', signature: 'cancelSubscription(subscriptionId) → { id, status }' },
      { name: 'listCustomers', signature: 'listCustomers(email?) → [{ id, email, name }]' },
      { name: 'retrievePaymentIntent', signature: 'retrievePaymentIntent(paymentIntentId) → object' },
      requestDoc(
        'Stripe bodies are form-encoded, as Stripe takes them: nested objects and lists become metadata[key] and items[0][price]. ' +
          "e.g. request('POST', '/products', { name: 'Pro plan', metadata: { tier: 'pro' } }).",
      ),
    ],
  },

  // ── Email ─────────────────────────────────────────────────────────────────
  // The typed email helper (ctx.integrations.email.send) picks Resend first,
  // SendGrid as fallback. resend/sendgrid also get their own .request() for
  // provider-specific endpoints (domains, audiences, templates, …).
  email: {
    id: 'email',
    displayName: 'Email (Resend / SendGrid)',
    category: 'email',
    connectedNames: ['email', 'resend', 'sendgrid'],
    keyStoreIds: ['resend', 'sendgrid'],
    auxKeyStoreId: 'email_from',
    rich: true,
    genericRequest: false,
    methods: [
      { name: 'send', signature: 'send({ to, subject, html, from?, text? }) → { id } — delivers via the connected Resend/SendGrid key' },
    ],
  },
  resend: {
    id: 'resend',
    displayName: 'Resend',
    category: 'email',
    connectedNames: ['resend', 'email'],
    keyStoreIds: ['resend'],
    baseUrl: 'https://api.resend.com',
    buildHeaders: (k) => ({ Authorization: `Bearer ${k}` }),
    genericRequest: true,
    keyFormat: 're_…',
    docsUrl: 'https://resend.com/docs/api-reference',
    methods: [REQUEST_DOC],
  },
  sendgrid: {
    id: 'sendgrid',
    displayName: 'SendGrid',
    category: 'email',
    connectedNames: ['sendgrid', 'email'],
    keyStoreIds: ['sendgrid'],
    baseUrl: 'https://api.sendgrid.com/v3',
    buildHeaders: (k) => ({ Authorization: `Bearer ${k}` }),
    genericRequest: true,
    keyFormat: 'SG.…',
    docsUrl: 'https://docs.sendgrid.com/api-reference',
    methods: [REQUEST_DOC],
  },

  // ── AI / LLM ──────────────────────────────────────────────────────────────
  openai: {
    id: 'openai',
    displayName: 'OpenAI',
    category: 'ai',
    connectedNames: ['openai'],
    keyStoreIds: ['openai'],
    baseUrl: 'https://api.openai.com/v1',
    buildHeaders: (k) => ({ Authorization: `Bearer ${k}` }),
    rich: true,
    genericRequest: true,
    keyFormat: 'sk-…',
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    methods: [
      {
        name: 'complete',
        signature:
          `complete(prompt, { model?, maxTokens?, system? }?) → string (a chat completion with ${OPENAI_DEFAULTS.complete.model} ` +
          'unless model names another; complete(prompt, maxTokens?, systemPrompt?) also works)',
      },
      { name: 'embed', signature: `embed(text) → number[] (${OPENAI_DEFAULTS.embed.model})` },
      REQUEST_DOC,
    ],
  },
  anthropic: {
    id: 'anthropic',
    displayName: 'Anthropic Claude',
    category: 'ai',
    connectedNames: ['anthropic', 'claude'],
    keyStoreIds: ['anthropic'],
    baseUrl: 'https://api.anthropic.com/v1',
    buildHeaders: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }),
    rich: true,
    genericRequest: true,
    keyFormat: 'sk-ant-…',
    docsUrl: 'https://docs.anthropic.com/en/api',
    methods: [
      {
        name: 'complete',
        signature:
          `complete(prompt, { model?, maxTokens?, system?, effort? }?) → string (${ANTHROPIC_DEFAULTS.model} at effort ` +
          `${ANTHROPIC_DEFAULTS.effort} unless model names another; complete(prompt, maxTokens?, systemPrompt?) also works). ` +
          'Anthropic has NO embeddings API — use openai.embed for vectors.',
      },
      REQUEST_DOC,
    ],
  },

  // ── SMS ───────────────────────────────────────────────────────────────────
  twilio: {
    id: 'twilio',
    displayName: 'Twilio',
    category: 'sms',
    connectedNames: ['twilio', 'sms'],
    keyStoreIds: ['twilio'],
    rich: true,
    genericRequest: false, // credential is "sid:token:from" — typed helper handles auth
    keyFormat: 'AC… (accountSid:authToken:fromNumber)',
    docsUrl: 'https://www.twilio.com/docs/usage/api',
    methods: [
      { name: 'sendSms', signature: 'sendSms({ to, body }) → { sid, status }' },
    ],
  },

  // ── Analytics ─────────────────────────────────────────────────────────────
  posthog: {
    id: 'posthog',
    displayName: 'PostHog',
    category: 'analytics',
    connectedNames: ['posthog'],
    keyStoreIds: ['posthog'],
    rich: true,
    genericRequest: false, // PostHog auth is via body api_key, not a header — typed helpers cover it
    keyFormat: 'phc_…',
    docsUrl: 'https://posthog.com/docs/api',
    methods: [
      { name: 'capture', signature: 'capture({ distinctId, event, properties? }) → { ok }' },
      { name: 'identify', signature: 'identify({ distinctId, properties }) → { ok }' },
      { name: 'isFeatureEnabled', signature: 'isFeatureEnabled(flagKey, distinctId) → boolean' },
    ],
  },

  // ── Video / generative AI providers ───────────────────────────────────────
  // Previously "phantom": advertised + key stored, but no ctx.integrations
  // surface. Now every one has a working .request().
  replicate: {
    id: 'replicate',
    displayName: 'Replicate',
    category: 'video',
    connectedNames: ['replicate', 'kling'],
    keyStoreIds: ['replicate'],
    baseUrl: 'https://api.replicate.com/v1',
    buildHeaders: (k) => ({ Authorization: `Token ${k}` }),
    genericRequest: true,
    keyFormat: 'r8_…',
    docsUrl: 'https://replicate.com/docs/reference/http',
    methods: [
      { name: 'request', signature: "request(method, path, body?, headers?) → JSON. e.g. request('POST', '/predictions', { version, input }) to run a model; request('GET', `/predictions/${id}`) to poll." },
    ],
  },
  runway: {
    id: 'runway',
    displayName: 'Runway ML',
    category: 'video',
    connectedNames: ['runway'],
    keyStoreIds: ['runway'],
    baseUrl: 'https://api.dev.runwayml.com/v1',
    buildHeaders: (k) => ({ Authorization: `Bearer ${k}`, 'X-Runway-Version': '2024-11-06' }),
    genericRequest: true,
    keyFormat: 'key_…',
    docsUrl: 'https://docs.dev.runwayml.com',
    methods: [
      { name: 'request', signature: "request(method, path, body?, headers?) → JSON. e.g. request('POST', '/image_to_video', {...}); poll with request('GET', `/tasks/${id}`)." },
    ],
  },
  stability: {
    id: 'stability',
    displayName: 'Stability AI',
    category: 'video',
    connectedNames: ['stability', 'stability_ai', 'stable_diffusion'],
    keyStoreIds: ['stability', 'stability_ai'],
    baseUrl: 'https://api.stability.ai',
    // Its image endpoints take multipart/form-data, and answer with the image's
    // bytes unless asked for JSON, which request() can hand back (the image as
    // base64). A call's own headers override either.
    buildHeaders: (k) => ({ Authorization: `Bearer ${k}`, Accept: 'application/json' }),
    bodyEncoding: 'multipart',
    genericRequest: true,
    keyFormat: 'sk-…',
    docsUrl: 'https://platform.stability.ai/docs/api-reference',
    methods: [
      {
        name: 'request',
        signature:
          "request(method, path, body?, headers?) → JSON. Bodies are sent as multipart/form-data and answers come back as JSON, an image as base64. " +
          "e.g. request('POST', '/v2beta/stable-image/generate/core', { prompt: 'a lighthouse at dusk', output_format: 'png' }) → { image, seed, finish_reason }. " +
          'A file field, such as an image to edit, is { base64, filename?, contentType? }.',
      },
    ],
  },

  // ── Push ──────────────────────────────────────────────────────────────────
  // OneSignal also has a first-class SEND_PUSH action + register-device function,
  // but expose request() so generated functions can hit any OneSignal endpoint.
  // The App ID is merged into every JSON body automatically.
  onesignal: {
    id: 'onesignal',
    displayName: 'OneSignal',
    category: 'push',
    connectedNames: ['onesignal', 'push'],
    keyStoreIds: ['onesignal'],
    baseUrl: 'https://onesignal.com/api/v1',
    buildHeaders: (k) => ({ Authorization: `Basic ${k}` }),
    auxKeyStoreId: 'onesignal_app_id',
    injectBody: (appId) => (appId ? { app_id: appId } : {}),
    genericRequest: true,
    keyFormat: 'REST API Key (+ App ID)',
    docsUrl: 'https://documentation.onesignal.com/reference',
    methods: [
      { name: 'request', signature: "request(method, path, body?, headers?) → JSON. app_id is injected into the body automatically. e.g. request('POST', '/notifications', { contents: { en: 'Hi' }, included_segments: ['Subscribed Users'] })." },
    ],
  },
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const CONNECTED_NAME_INDEX: Record<string, string> = (() => {
  const idx: Record<string, string> = {}
  for (const spec of Object.values(INTEGRATION_PROVIDERS)) {
    for (const name of spec.connectedNames) {
      // First spec that claims a name wins (stripe, email, … registered first).
      if (!(name in idx)) idx[name.toLowerCase()] = spec.id
    }
    idx[spec.id.toLowerCase()] = spec.id
  }
  return idx
})()

/** Look up a provider spec by its canonical id. */
export function getProviderSpec(id: string): ProviderSpec | null {
  return INTEGRATION_PROVIDERS[id] ?? null
}

/** Resolve any alias ('claude', 'kling', 'sms', …) to a canonical provider id. */
export function resolveProviderId(alias: string): string | null {
  if (!alias) return null
  return CONNECTED_NAME_INDEX[alias.toLowerCase()] ?? null
}

/** Every provider that exposes the universal request() helper (has baseUrl + headers). */
export function genericRequestProviders(): ProviderSpec[] {
  return Object.values(INTEGRATION_PROVIDERS).filter(
    (s) => s.genericRequest !== false && !!s.baseUrl && !!s.buildHeaders,
  )
}

/** All provider ids known to the registry. */
export function allProviderIds(): string[] {
  return Object.keys(INTEGRATION_PROVIDERS)
}

/** True when the given id/alias is a first-class connector Backenly knows how to wire. */
export function isKnownProvider(alias: string): boolean {
  return resolveProviderId(alias) !== null
}

/**
 * The connectable catalogue, for any surface that needs to TELL somebody what
 * Backenly integrates with — docs, the brain's answers, the "no integrations
 * connected" hint, the dashboard.
 *
 * Every one of those used to keep its own hand-written list, and they disagreed.
 * The public docs advertised OneSignal and omitted Resend, SendGrid and Twilio;
 * the runtime's own hint listed those three and omitted OneSignal, Replicate,
 * Runway and Stability. So a documented connector appeared not to exist, and
 * four real ones were invisible unless you already knew their names. Both lists
 * were wrong about a registry that has been correct the whole time.
 *
 * `email` is filtered out: it is an alias that routes to whichever email
 * provider is connected, not a thing you can connect.
 */
export function connectableProviders(): Array<{
  id: string
  displayName: string
  category: IntegrationCategory
  /** The typed helpers this provider exposes, beyond the universal request(). */
  methods: string[]
  keyFormat?: string
  docsUrl?: string
}> {
  return Object.values(INTEGRATION_PROVIDERS)
    .filter((s) => s.id !== 'email')
    .map((s) => ({
      id: s.id,
      displayName: s.displayName,
      category: s.category,
      methods: s.methods.map((m) => m.name).filter((n) => n !== 'request'),
      ...(s.keyFormat ? { keyFormat: s.keyFormat } : {}),
      ...(s.docsUrl ? { docsUrl: s.docsUrl } : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** One-line, comma-separated list of connectable provider ids. */
export function connectableProviderIds(): string {
  return connectableProviders().map((p) => p.id).join(', ')
}

/**
 * Render the ctx.integrations documentation block for the codegen prompt, given
 * the canonical ids of the providers connected on this project. Registry-driven,
 * so a new provider is documented automatically. Returns '' when nothing is
 * connected (caller shows the "no integrations" branch instead).
 */
export function renderIntegrationDocs(connectedIds: string[]): string {
  const seen = new Set<string>()
  const specs: ProviderSpec[] = []
  for (const id of connectedIds) {
    const spec = INTEGRATION_PROVIDERS[id]
    if (spec && !seen.has(spec.id)) {
      seen.add(spec.id)
      specs.push(spec)
    }
  }
  if (specs.length === 0) return ''

  const lines: string[] = []
  for (const spec of specs) {
    const base = spec.genericRequest !== false && spec.baseUrl && spec.buildHeaders ? ` (request() base: ${spec.baseUrl})` : ''
    lines.push(`• ${spec.displayName} — ctx.integrations.${spec.id}${base}`)
    for (const m of spec.methods) {
      lines.push(`    ctx.integrations.${spec.id}.${m.signature}`)
    }
  }

  return [
    'CONNECTED INTEGRATIONS (use ctx.integrations.* — these are the ONLY methods that exist; never invent others):',
    lines.join('\n'),
    '',
    "ctx.integrations.isConnected('<name>') → boolean — check before calling.",
    'ALWAYS await ctx.integrations calls — they are async.',
    'For any endpoint a typed helper does not cover, use the provider\'s .request(method, path, body?) helper.',
    'NOTE: inbound webhook signatures are verified by the platform BEFORE your function runs — event.data is already verified; do not re-verify.',
  ].join('\n')
}
