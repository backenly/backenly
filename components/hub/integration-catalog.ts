/**
 * What the Integrations page offers, built from the provider registry.
 *
 * The page used to keep its own hand-written list of five providers (Stripe,
 * Resend, OpenAI, Anthropic, PostHog) while the MCP `integrations` tool and the
 * functions runtime served eleven from the registry
 * (lib/services/ai-functions/integration-registry.ts). Production QA
 * (2026-11-09) found the two disagreeing about what exists: SendGrid, Twilio,
 * OneSignal, Replicate, Runway and Stability could be connected by an agent and
 * called from a function, and the console did not offer them at all.
 *
 * The registry now decides which providers the page offers and under which
 * category. What is written here is presentation only: the words on a card and
 * in the connect dialog. A provider the registry gains without words here is
 * still offered, with a plain card built from the registry.
 */

import {
  connectableProviders,
  type IntegrationCategory,
} from '@/lib/services/ai-functions/integration-registry'

export interface QuickOption {
  label: string
  intent: string
}

/** A second credential a provider needs beside its key (Stripe's signing secret, OneSignal's App ID). */
export interface SecondaryCredential {
  /** Key vault id the value is stored under. */
  vaultId: string
  /** The field's name, as the credentials route and the key store know it. */
  envVar: string
  placeholder: string
  label: string
  helperText: string
  docsUrl: string
  /**
   * What stays off until this credential is stored. The provider counts as
   * connected only with both, and the console says why beside the field.
   */
  missingMeans: string
  /**
   * Where the provider sends events, under the project's API base URL, for a
   * credential the provider issues only once that address is entered there.
   */
  endpointPath?: string
}

export interface CatalogProvider {
  id: string
  name: string
  tagline: string
  /**
   * Catalog-card body: what connecting it gets you, drawn from `provisions` so
   * the card never promises something the agent cannot build.
   */
  description: string
  /** Official brand hex, applied to the logo glyph only. */
  brandColor?: string
  provisions: string[]
  /** The key's field name, as the credentials route and the key store know it. */
  envVar: string
  keyPlaceholder: string
  keyHelperText: string
  keyDocsUrl: string
  quickOptions: QuickOption[]
  webhookKey?: SecondaryCredential
}

export interface CatalogCategory {
  id: IntegrationCategory
  title: string
  description: string
  providers: CatalogProvider[]
}

/** Categories in the order the page shows them, with their words. */
const CATEGORIES: Array<{ id: IntegrationCategory; title: string; description: string }> = [
  { id: 'payments', title: 'Payments', description: 'Monetize your app: subscriptions, one-time purchases, billing.' },
  { id: 'email', title: 'Email', description: 'Transactional email delivery: welcome flows, alerts, receipts.' },
  { id: 'sms', title: 'SMS', description: 'Text messages to your users: order updates, alerts, sign-in codes.' },
  { id: 'push', title: 'Push notifications', description: 'Notifications to your app’s users on their phones and in the browser.' },
  { id: 'ai', title: 'AI / LLM', description: 'Add AI features: text generation, embeddings, completions.' },
  { id: 'video', title: 'Image & video generation', description: 'Generate images and video from prompts or pictures.' },
  { id: 'analytics', title: 'Analytics & Product Intelligence', description: 'Track user behaviour, product funnels, feature flags, and session replay.' },
  { id: 'other', title: 'Other', description: 'More providers your functions can call.' },
]

type Presentation = Omit<CatalogProvider, 'id' | 'name'> & { name?: string }

const PRESENTATION: Record<string, Presentation> = {
  stripe: {
    tagline: 'Payment processing',
    description:
      'Subscriptions, one-time checkout, and usage billing, built by your agent in Backenly: checkout, plan schema, and a payment event log behind a signed webhook receiver.',
    brandColor: '#635BFF',
    provisions: [
      'Stripe webhook endpoint',
      'Subscription schema (plans, billing_cycles)',
      'Payment events table',
      'Checkout session logic',
    ],
    envVar: 'STRIPE_SECRET_KEY',
    keyPlaceholder: 'sk_live_…  or  sk_test_…',
    keyHelperText: 'Find your key in the Stripe Dashboard → Developers → API keys',
    keyDocsUrl: 'https://dashboard.stripe.com/apikeys',
    quickOptions: [
      { label: 'Subscription billing (monthly / annual plans)', intent: 'Add subscription billing with monthly and annual plans, payment management, and billing history' },
      { label: 'One-time purchases at checkout', intent: 'Add one-time purchase checkout with payment processing and order confirmation' },
      { label: 'Usage-based billing', intent: 'Add usage-based billing that charges users based on their consumption' },
      { label: 'Free trial then paid plan', intent: 'Add a free trial flow that converts to a paid subscription after the trial period' },
    ],
    webhookKey: {
      vaultId: 'stripe_webhook_secret',
      envVar: 'STRIPE_WEBHOOK_SECRET',
      placeholder: 'whsec_…',
      label: 'Webhook Secret',
      helperText: 'Dashboard → Webhooks → your endpoint → Signing secret',
      docsUrl: 'https://dashboard.stripe.com/webhooks',
      // app/api/v1/[projectId]/webhooks/[integration]/route.ts answers 401 to
      // every Stripe event until the signing secret is stored.
      missingMeans: 'Until it is stored, Backenly refuses every event Stripe sends, so no function runs on a Stripe event.',
      endpointPath: 'webhooks/stripe',
    },
  },
  resend: {
    tagline: 'Developer-first email',
    description:
      'Transactional email that reaches inboxes. Welcome flows, receipts, and password resets, each with a delivery event log.',
    brandColor: '#FFFFFF',
    provisions: ['Email service endpoint', 'Welcome email template', 'Delivery event log'],
    envVar: 'RESEND_API_KEY',
    keyPlaceholder: 're_…',
    keyHelperText: 'Find your key in the Resend Dashboard → API Keys',
    keyDocsUrl: 'https://resend.com/api-keys',
    quickOptions: [
      { label: 'Welcome email on sign-up', intent: 'Send a welcome email when a user signs up' },
      { label: 'Order confirmation emails', intent: 'Send order confirmation emails when a purchase is made' },
      { label: 'Password reset emails', intent: 'Send password reset emails with secure links' },
      { label: 'Abandoned cart reminders', intent: 'Send abandoned cart reminder emails to users who did not complete checkout' },
      { label: 'General notifications', intent: 'Send transactional notification emails for key user actions' },
    ],
  },
  sendgrid: {
    tagline: 'Transactional email',
    description:
      'Transactional email sent through your SendGrid account: welcome flows, receipts and alerts, each with a delivery event log. When Resend is also connected, Resend sends first.',
    provisions: ['Email sending from functions and triggers', 'Welcome email template', 'Delivery event log'],
    envVar: 'SENDGRID_API_KEY',
    keyPlaceholder: 'SG.…',
    keyHelperText: 'Find your key in SendGrid → Settings → API Keys',
    keyDocsUrl: 'https://app.sendgrid.com/settings/api_keys',
    quickOptions: [
      { label: 'Welcome email on sign-up', intent: 'Send a welcome email through SendGrid when a user signs up' },
      { label: 'Order confirmation emails', intent: 'Send order confirmation emails through SendGrid when a purchase is made' },
      { label: 'General notifications', intent: 'Send transactional notification emails through SendGrid for key user actions' },
    ],
  },
  twilio: {
    tagline: 'SMS',
    description:
      'Text messages from your functions and triggers: order updates, alerts and sign-in codes, sent from your Twilio number.',
    provisions: ['SMS sending from functions and triggers', 'Message log table'],
    envVar: 'TWILIO_CREDENTIALS',
    keyPlaceholder: 'AC…:auth-token:+15550001111',
    keyHelperText:
      'Your Account SID, auth token and sending number, separated by colons. Find them in the Twilio Console.',
    keyDocsUrl: 'https://console.twilio.com',
    quickOptions: [
      { label: 'Text the customer when an order ships', intent: 'Send an SMS through Twilio when an order is marked shipped' },
      { label: 'Sign-in codes by SMS', intent: 'Send one-time sign-in codes by SMS through Twilio' },
      { label: 'Alert me by SMS', intent: 'Send me an SMS through Twilio when something in the backend needs attention' },
    ],
  },
  onesignal: {
    tagline: 'Push notifications',
    description:
      'Push notifications to your app’s users through your OneSignal app, sent from functions and triggers. Push works once both the REST API key and the App ID are stored.',
    provisions: ['Device registration endpoint', 'Push sending from functions and triggers', 'Notification log table'],
    envVar: 'ONESIGNAL_REST_API_KEY',
    keyPlaceholder: 'REST API key',
    keyHelperText: 'OneSignal → Settings → Keys & IDs → REST API Key',
    keyDocsUrl: 'https://dashboard.onesignal.com',
    quickOptions: [
      { label: 'Notify a user when their order ships', intent: 'Send a push notification through OneSignal when a user’s order is marked shipped' },
      { label: 'Notify followers of a new post', intent: 'Send a push notification through OneSignal to a user’s followers when they publish a post' },
      { label: 'Remind inactive users', intent: 'Send a push notification through OneSignal to users who have not opened the app in 7 days' },
    ],
    webhookKey: {
      vaultId: 'onesignal_app_id',
      envVar: 'ONESIGNAL_APP_ID',
      placeholder: '00000000-0000-0000-0000-000000000000',
      label: 'App ID',
      helperText: 'OneSignal → Settings → Keys & IDs → OneSignal App ID',
      docsUrl: 'https://dashboard.onesignal.com',
      missingMeans: 'Until it is stored, push notifications are not sent.',
    },
  },
  openai: {
    tagline: 'GPT-4 & embeddings',
    description:
      'GPT models and embeddings behind a governed endpoint, with request quotas and stored responses so a runaway loop cannot drain your key.',
    brandColor: '#FFFFFF',
    provisions: ['AI completion endpoint', 'Request quota & rate limiting', 'Response storage table'],
    envVar: 'OPENAI_API_KEY',
    keyPlaceholder: 'sk-…',
    keyHelperText: 'Find your key in the OpenAI Platform → API keys',
    keyDocsUrl: 'https://platform.openai.com/api-keys',
    quickOptions: [
      { label: 'Product description generation', intent: 'Add AI-powered product description generation that creates compelling descriptions from product attributes' },
      { label: 'AI search & recommendations', intent: 'Add AI-powered search and product recommendations based on user preferences and browsing history' },
      { label: 'Customer support chatbot', intent: 'Add an AI customer support chatbot that answers questions about products, orders, and policies' },
      { label: 'Review sentiment analysis', intent: 'Add AI sentiment analysis for customer reviews to automatically tag and surface insights' },
      { label: 'Content & copy generation', intent: 'Add AI content generation for marketing copy, blog posts, and promotional material' },
    ],
  },
  anthropic: {
    name: 'Anthropic',
    tagline: 'Claude models',
    description:
      'Claude models behind a governed endpoint, with request quotas and stored responses so a runaway loop cannot drain your key.',
    brandColor: '#D97757',
    provisions: ['AI completion endpoint', 'Request quota & rate limiting', 'Response storage table'],
    envVar: 'ANTHROPIC_API_KEY',
    keyPlaceholder: 'sk-ant-api03-…',
    keyHelperText: 'Find your key in the Anthropic Console → API keys',
    keyDocsUrl: 'https://console.anthropic.com/settings/keys',
    quickOptions: [
      { label: 'Customer support chatbot', intent: 'Add an AI customer support chatbot powered by Claude that answers questions about products, orders, and policies' },
      { label: 'Content & copy generation', intent: 'Add AI content generation with Claude for marketing copy, blog posts, and promotional material' },
      { label: 'Document summarization', intent: 'Add AI document summarization with Claude that condenses long text into concise summaries' },
      { label: 'Review sentiment analysis', intent: 'Add AI sentiment analysis with Claude for customer reviews to automatically tag and surface insights' },
      { label: 'Smart data extraction', intent: 'Add AI-powered structured data extraction with Claude that pulls structured fields from unstructured text' },
    ],
  },
  replicate: {
    tagline: 'Hosted open models',
    description:
      'Image, video and language models hosted on Replicate, run from your functions, with results stored in your backend.',
    provisions: ['Model runs from functions', 'Run status tracking', 'Generated files stored in a bucket'],
    envVar: 'REPLICATE_API_TOKEN',
    keyPlaceholder: 'r8_…',
    keyHelperText: 'Find your token in Replicate → Account settings → API tokens',
    keyDocsUrl: 'https://replicate.com/account/api-tokens',
    quickOptions: [
      { label: 'Generate an image from a prompt', intent: 'Generate an image with a Replicate model from a prompt and store it in a bucket' },
      { label: 'Upscale uploaded images', intent: 'Upscale images users upload with a Replicate model and store the result' },
    ],
  },
  runway: {
    name: 'Runway',
    tagline: 'AI video',
    description: 'Video generated from images and prompts with Runway, run from your functions and stored in your backend.',
    provisions: ['Video generation from functions', 'Task status tracking', 'Generated videos stored in a bucket'],
    envVar: 'RUNWAYML_API_SECRET',
    keyPlaceholder: 'key_…',
    keyHelperText: 'Find your key in the Runway developer portal → API keys',
    keyDocsUrl: 'https://dev.runwayml.com',
    quickOptions: [
      { label: 'Turn an image into a short video', intent: 'Generate a short video with Runway from an image a user uploads and store it' },
    ],
  },
  stability: {
    tagline: 'AI images',
    description: 'Images generated and edited with Stability AI, run from your functions and stored in your backend.',
    provisions: ['Image generation from functions', 'Generated images stored in a bucket'],
    envVar: 'STABILITY_API_KEY',
    keyPlaceholder: 'sk-…',
    keyHelperText: 'Find your key in the Stability AI platform → Account → API keys',
    keyDocsUrl: 'https://platform.stability.ai/account/keys',
    quickOptions: [
      { label: 'Generate an image from a prompt', intent: 'Generate an image with Stability AI from a prompt and store it in a bucket' },
    ],
  },
  posthog: {
    tagline: 'Product analytics & feature flags',
    description:
      'Funnels, feature flags, and session replay captured server-side, so your events survive ad blockers and client failures.',
    brandColor: '#F9BD2B',
    provisions: [
      'Server-side event capture endpoint',
      'User identify & group endpoint',
      'Feature flag evaluation helper',
      'Analytics event schema (sign-up, purchase, funnel events)',
    ],
    envVar: 'POSTHOG_API_KEY',
    keyPlaceholder: 'phc_…',
    keyHelperText: 'PostHog → Project Settings → Project API key (starts with phc_)',
    keyDocsUrl: 'https://app.posthog.com/project/settings',
    quickOptions: [
      { label: 'Track user sign-ups and activation events', intent: 'Connect PostHog and track user_signed_up, account_activated, and first_action events with user properties' },
      { label: 'Track e-commerce funnel (view → cart → purchase)', intent: 'Connect PostHog and track product_viewed, added_to_cart, checkout_started, and order_completed events' },
      { label: 'Track feature usage and engagement', intent: 'Connect PostHog and track feature_used events for key product features to measure engagement and retention' },
      { label: 'Enable feature flags for gradual rollouts', intent: 'Connect PostHog and add feature flag evaluation so I can roll out new features gradually to specific user segments' },
      { label: 'Session replay + custom events', intent: 'Connect PostHog with session replay enabled and set up custom event tracking for my key user flows' },
    ],
  },
}

/** A card for a provider the registry has and this file has no words for yet. */
function plainPresentation(p: ReturnType<typeof connectableProviders>[number]): Presentation {
  return {
    tagline: CATEGORIES.find((c) => c.id === p.category)?.title ?? 'Integration',
    description: `Calls to ${p.displayName} from your functions, with the key kept out of code.`,
    provisions: [`Calls to ${p.displayName} from functions and triggers`],
    envVar: `${p.id.toUpperCase()}_API_KEY`,
    keyPlaceholder: p.keyFormat ?? 'API key',
    keyHelperText: `Paste your ${p.displayName} API key.`,
    keyDocsUrl: p.docsUrl ?? '',
    quickOptions: [],
  }
}

/** Every provider the registry can wire, grouped by its category, in page order. */
export function integrationCatalog(): CatalogCategory[] {
  const byCategory = new Map<IntegrationCategory, CatalogProvider[]>()
  for (const p of connectableProviders()) {
    const shown = PRESENTATION[p.id] ?? plainPresentation(p)
    const { name, ...rest } = shown
    const providers = byCategory.get(p.category) ?? []
    providers.push({ id: p.id, name: name ?? p.displayName, ...rest })
    byCategory.set(p.category, providers)
  }
  return CATEGORIES.filter((c) => byCategory.has(c.id)).map((c) => ({ ...c, providers: byCategory.get(c.id)! }))
}
