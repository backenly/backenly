'use client'

/**
 * INTEGRATIONS → CAPABILITY SURFACE
 *
 * 2-step activation modal (Replit-style):
 *   Step 1 → paste API key  (stored encrypted via /api/projects/[id]/credentials)
 *   Step 2 → describe intent, handed off as a copy-ready prompt for the user's
 *            coding agent over MCP (the one build door) to provision the
 *            right tables/endpoints
 *
 * Nothing is hardcoded to a specific use-case (e.g. "blog posts").
 * The user defines exactly what they want before anything is provisioned.
 *
 * Presentation composes components/inspector/kit.tsx — the page H1 lives in
 * the route wrapper's InspectorPageHeader; this panel renders content only.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams } from 'next/navigation'
import {
  Eye,
  EyeOff,
  CreditCard,
  Mail,
  Brain,
  Check,
  ChevronRight,
  Zap,
  Loader2,
  ArrowLeft,
  ExternalLink,
  BarChart2,
  Search,
  Plus,
  Info,
  Copy,
} from 'lucide-react'
import {
  KIT,
  KitCard,
  KitBadge,
  KitButton,
  KitTabs,
  KitTab,
  KitModal,
  KitField,
  KitInput,
  KitTextarea,
  KitNote,
  KitChecklist,
  SectionTitle,
  EmptyState,
} from '@/components/inspector/kit'

// ─── Brand logos ────────────────────────────────────────────────────────────────
// Official marks (simple-icons, CC0). Rendered with currentColor; the provider's
// brand hex is applied to the glyph only — never to surfaces or chrome.

type LogoProps = { className?: string; style?: React.CSSProperties }

function StripeLogo({ className, style }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} fill="currentColor" aria-hidden="true">
      <path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z" />
    </svg>
  )
}

function OpenAILogo({ className, style }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} fill="currentColor" aria-hidden="true">
      <path d="M22.282 9.821a6 6 0 0 0-.516-4.91a6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9a6.05 6.05 0 0 0 .743 7.097a5.98 5.98 0 0 0 .51 4.911a6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206a6 6 0 0 0 3.997-2.9a6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081l4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085l4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354l-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023l-.141-.085l-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365l2.602-1.5l2.607 1.5v2.999l-2.597 1.5l-2.607-1.5Z" />
    </svg>
  )
}

function AnthropicLogo({ className, style }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} fill="currentColor" aria-hidden="true">
      <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
    </svg>
  )
}

function ResendLogo({ className, style }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} fill="currentColor" aria-hidden="true">
      <path d="M14.679 0c4.648 0 7.413 2.765 7.413 6.434s-2.765 6.434-7.413 6.434H12.33L24 24h-8.245l-8.88-8.44c-.636-.588-.93-1.273-.93-1.86 0-.831.587-1.565 1.713-1.883l4.574-1.224c1.737-.465 2.936-1.81 2.936-3.572 0-2.153-1.761-3.4-3.939-3.4H0V0z" />
    </svg>
  )
}

function PostHogLogo({ className, style }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} fill="currentColor" aria-hidden="true">
      <path d="M9.854 14.5 5 9.647.854 5.5A.5.5 0 0 0 0 5.854V8.44a.5.5 0 0 0 .146.353L5 13.647l.147.146L9.854 18.5l.146.147v-.049c.065.03.134.049.207.049h2.586a.5.5 0 0 0 .353-.854L9.854 14.5zm0-5-4-4a.487.487 0 0 0-.409-.144.515.515 0 0 0-.356.21.493.493 0 0 0-.089.288V8.44a.5.5 0 0 0 .147.353l9 9a.5.5 0 0 0 .853-.354v-2.585a.5.5 0 0 0-.146-.354l-5-5zm1-4a.5.5 0 0 0-.854.354V8.44a.5.5 0 0 0 .147.353l4 4a.5.5 0 0 0 .853-.354V9.854a.5.5 0 0 0-.146-.354l-4-4zm12.647 11.515a3.863 3.863 0 0 1-2.232-1.1l-4.708-4.707a.5.5 0 0 0-.854.354v6.585a.5.5 0 0 0 .5.5H23.5a.5.5 0 0 0 .5-.5v-.6c0-.276-.225-.497-.499-.532zm-5.394.032a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6zM.854 15.5a.5.5 0 0 0-.854.354v2.293a.5.5 0 0 0 .5.5h2.293c.222 0 .39-.135.462-.309a.493.493 0 0 0-.109-.545L.854 15.501zM5 14.647.854 10.5a.5.5 0 0 0-.854.353v2.586a.5.5 0 0 0 .146.353L4.854 18.5l.146.147h2.793a.5.5 0 0 0 .353-.854L5 14.647z" />
    </svg>
  )
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface KeyVaultStatus {
  maskedKey: string
  connectedAt: string
}

interface QuickOption {
  label: string
  intent: string
}

interface WebhookKeyConfig {
  /** Key vault integration ID — e.g. 'stripe_webhook_secret' */
  vaultId: string
  /** Environment variable name — e.g. 'STRIPE_WEBHOOK_SECRET' */
  envVar: string
  placeholder: string
  label: string
  helperText: string
  docsUrl: string
  /** Filled in at runtime from keyVault response */
  keyStatus?: KeyVaultStatus
}

interface Provider {
  id: string
  name: string
  tagline: string
  /**
   * Catalog-card body. A tagline names the provider; this says what connecting
   * it actually gets you, drawn from `provisions` so the card never promises
   * something the activation does not build.
   */
  description: string
  /** Official brand mark — falls back to the category icon if omitted */
  logo?: React.ComponentType<{ className?: string; style?: React.CSSProperties }>
  /** Official brand hex — applied to the logo glyph only. */
  brandColor?: string
  enabled: boolean
  keyStatus?: KeyVaultStatus
  provisions: string[]
  // Modal metadata
  envVar: string
  keyPlaceholder: string
  keyHelperText: string
  keyDocsUrl: string
  quickOptions: QuickOption[]
  /** Optional secondary credential (e.g. Stripe webhook secret) */
  webhookKey?: WebhookKeyConfig
}

interface IntegrationCategory {
  id: string
  title: string
  description: string
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>
  providers: Provider[]
}

// ─── Static catalog ───────────────────────────────────────────────────────────

const INTEGRATION_CATALOG: IntegrationCategory[] = [
  {
    id: 'payments',
    title: 'Payments',
    description: 'Monetize your app: subscriptions, one-time purchases, billing.',
    icon: CreditCard,
    providers: [
      {
        id: 'stripe',
        name: 'Stripe',
        tagline: 'Payment processing',
        description:
          'Subscriptions, one-time checkout, and usage billing. Backenly provisions the webhook endpoint, the plan schema, and a payment event log.',
        logo: StripeLogo,
        brandColor: '#635BFF',
        enabled: false,
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
        },
      },
    ],
  },
  {
    id: 'email',
    title: 'Email & Notifications',
    description: 'Transactional email delivery: welcome flows, alerts, receipts.',
    icon: Mail,
    providers: [
      {
        id: 'resend',
        name: 'Resend',
        tagline: 'Developer-first email',
        description:
          'Transactional email that reaches inboxes. Welcome flows, receipts, and password resets, each with a delivery event log.',
        logo: ResendLogo,
        brandColor: '#FFFFFF',
        enabled: false,
        provisions: [
          'Email service endpoint',
          'Welcome email template',
          'Delivery event log',
        ],
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
    ],
  },
  {
    id: 'ai',
    title: 'AI / LLM',
    description: 'Add AI features: text generation, embeddings, completions.',
    icon: Brain,
    providers: [
      {
        id: 'openai',
        name: 'OpenAI',
        tagline: 'GPT-4 & embeddings',
        description:
          'GPT models and embeddings behind a governed endpoint, with request quotas and stored responses so a runaway loop cannot drain your key.',
        logo: OpenAILogo,
        brandColor: '#10A37F',
        enabled: false,
        provisions: [
          'AI completion endpoint',
          'Request quota & rate limiting',
          'Response storage table',
        ],
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
      {
        id: 'anthropic',
        name: 'Anthropic',
        tagline: 'Claude models',
        description:
          'Claude models behind a governed endpoint, with request quotas and stored responses so a runaway loop cannot drain your key.',
        logo: AnthropicLogo,
        brandColor: '#D97757',
        enabled: false,
        provisions: [
          'AI completion endpoint',
          'Request quota & rate limiting',
          'Response storage table',
        ],
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
    ],
  },
  {
    id: 'analytics',
    title: 'Analytics & Product Intelligence',
    description: 'Track user behaviour, product funnels, feature flags, and session replay.',
    icon: BarChart2,
    providers: [
      {
        id: 'posthog',
        name: 'PostHog',
        tagline: 'Product analytics & feature flags',
        description:
          'Funnels, feature flags, and session replay captured server-side, so your events survive ad blockers and client failures.',
        logo: PostHogLogo,
        brandColor: '#F9BD2B',
        enabled: false,
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
    ],
  },
]

// ─── Provider logomark ────────────────────────────────────────────────────────
// Neutral chip; the brand hex lives on the glyph only.

function ProviderMark({
  provider,
  category,
  size = 'md',
}: {
  provider: Provider
  category: IntegrationCategory
  size?: 'md' | 'lg'
}) {
  const Logo = provider.logo ?? category.icon
  const box = size === 'lg' ? 'w-10 h-10' : 'w-8 h-8'
  const glyph = size === 'lg' ? 'w-5 h-5' : 'w-4 h-4'
  return (
    <div className={`${box} ${KIT.radiusSm} flex items-center justify-center border ${KIT.border} ${KIT.surfaceAlt} flex-shrink-0`}>
      <Logo
        className={`${glyph} ${provider.brandColor ? '' : 'text-zinc-300'}`}
        style={provider.brandColor ? { color: provider.brandColor } : undefined}
      />
    </div>
  )
}

// ─── Activation Modal ─────────────────────────────────────────────────────────

function ActivationModal({
  provider,
  category,
  projectId,
  onClose,
  onActivated,
}: {
  provider: Provider
  category: IntegrationCategory
  projectId: string
  onClose: () => void
  onActivated: (providerId: string) => void
}) {
  const [step, setStep] = useState<1 | 2>(1)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [keyError, setKeyError] = useState('')
  const [webhookKey, setWebhookKey] = useState('')
  const [showWebhookKey, setShowWebhookKey] = useState(false)
  const [selectedOptions, setSelectedOptions] = useState<string[]>([])
  const [customIntent, setCustomIntent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [done, setDone] = useState(false)
  const [copied, setCopied] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus the key input when the modal opens
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 80)
  }, [])

  function validateKey() {
    const trimmed = apiKey.trim()
    if (!trimmed) { setKeyError('Paste your API key to continue.'); return false }
    if (trimmed.length < 10) { setKeyError('This doesn\'t look like a valid API key.'); return false }
    setKeyError('')
    return true
  }

  function handleStep1Continue() {
    if (validateKey()) setStep(2)
  }

  function toggleOption(intent: string) {
    setSelectedOptions(prev =>
      prev.includes(intent) ? prev.filter(i => i !== intent) : [...prev, intent]
    )
  }

  function buildFinalIntent(): string {
    const parts: string[] = [...selectedOptions]
    if (customIntent.trim()) parts.push(customIntent.trim())
    if (parts.length === 0) return `Add ${provider.name} integration to this project`
    if (parts.length === 1) return parts[0]
    return parts.join('. ') + '.'
  }

  async function handleActivate() {
    setSubmitting(true)
    setSubmitError('')

    try {
      // ── Step A: store the key(s) securely ───────────────────────────────────
      const values: Record<string, string> = { [provider.envVar]: apiKey.trim() }
      if (provider.webhookKey && webhookKey.trim()) {
        values[provider.webhookKey.envVar] = webhookKey.trim()
      }
      const credRes = await fetch(`/api/projects/${projectId}/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integrationId: provider.id,
          values,
        }),
      })
      const credData = await credRes.json()
      if (!credRes.ok || !credData.success) {
        setSubmitError(credData.error || 'Failed to save your API key. Please try again.')
        setSubmitting(false)
        return
      }

      // ── Step B: hand the provisioning intent to the user's coding agent ─────
      // The key is stored; feature provisioning flows through the one build
      // door (their agent over MCP). The done state offers the intent as a
      // copy-ready prompt.
      setDone(true)
      onActivated(provider.id)
    } catch {
      setSubmitError('Network error. Check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const canActivate = selectedOptions.length > 0 || customIntent.trim().length > 0

  const description = done
    ? 'Key stored. Hand the prompt to your agent'
    : step === 1
      ? 'Step 1 of 2: paste your API key'
      : 'Step 2 of 2: describe what to provision'

  return (
    <KitModal
      open
      onClose={onClose}
      title={done ? `${provider.name} connected` : `Activate ${provider.name}`}
      description={description}
      footer={
        done ? (
          <>
            <KitButton
              variant="secondary"
              icon={copied ? Check : Copy}
              onClick={() => {
                navigator.clipboard?.writeText(buildFinalIntent()).catch(() => {})
                setCopied(true)
                setTimeout(() => setCopied(false), 1600)
              }}
            >
              {copied ? 'Copied' : 'Copy prompt'}
            </KitButton>
            <KitButton variant="primary" onClick={onClose}>Done</KitButton>
          </>
        ) : step === 1 ? (
          <KitButton
            variant="primary"
            iconRight={ChevronRight}
            onClick={handleStep1Continue}
            disabled={!apiKey.trim()}
          >
            Continue
          </KitButton>
        ) : (
          <>
            <KitButton variant="ghost" icon={ArrowLeft} onClick={() => { setStep(1); setSubmitError('') }}>
              Back
            </KitButton>
            <KitButton
              variant="primary"
              onClick={handleActivate}
              disabled={submitting || !canActivate}
            >
              {submitting
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Activating…</>
                : <><Zap className="w-3.5 h-3.5" /> Activate {provider.name}</>}
            </KitButton>
          </>
        )
      }
    >
      {step === 1 && !done && (
        <div className="space-y-4">
          <p className="text-[11.5px] text-zinc-500 leading-snug">
            Your key is encrypted with AES-256-GCM and never exposed to the client again after this step.
          </p>

          <KitField label={<span className="font-mono">{provider.envVar}</span>}>
            <div className="relative">
              <KitInput
                ref={inputRef}
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={e => { setApiKey(e.target.value); setKeyError('') }}
                onKeyDown={e => { if (e.key === 'Enter') handleStep1Continue() }}
                placeholder={provider.keyPlaceholder}
                className={`pr-9 font-mono ${keyError ? 'border-rose-500/40' : ''}`}
              />
              <button
                type="button"
                onClick={() => setShowKey(v => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300 transition-colors"
              >
                {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
            {keyError && <p className="text-[11.5px] text-rose-300 mt-1.5">{keyError}</p>}
          </KitField>

          <a
            href={provider.keyDocsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-[11.5px] text-zinc-500 hover:text-zinc-200 transition-colors w-fit"
          >
            <ExternalLink className="w-3 h-3" />
            {provider.keyHelperText}
          </a>

          {provider.webhookKey && (
            <div className={`pt-3 border-t ${KIT.hairline}`}>
              <KitField
                label={
                  <span className="font-mono">
                    {provider.webhookKey.envVar}
                    <span className="ml-2 font-sans text-zinc-600 font-normal">optional · add after deploying</span>
                  </span>
                }
              >
                <div className="relative">
                  <KitInput
                    type={showWebhookKey ? 'text' : 'password'}
                    value={webhookKey}
                    onChange={e => setWebhookKey(e.target.value)}
                    placeholder={provider.webhookKey.placeholder}
                    className="pr-9 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowWebhookKey(v => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300 transition-colors"
                  >
                    {showWebhookKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </KitField>
              <a
                href={provider.webhookKey.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-[11.5px] text-zinc-500 hover:text-zinc-200 transition-colors w-fit mt-1.5"
              >
                <ExternalLink className="w-3 h-3" />
                {provider.webhookKey.helperText}
              </a>
            </div>
          )}
        </div>
      )}

      {step === 2 && !done && (
        <div className="space-y-4">
          <div>
            <p className="text-[12.5px] font-semibold text-zinc-100 mb-1">
              What do you want to use {provider.name} for?
            </p>
            <p className="text-[11.5px] text-zinc-500 mb-3">
              Select one or more, or describe it yourself. Backenly will provision exactly what you need.
            </p>

            <div className="space-y-1.5">
              {provider.quickOptions.map(opt => {
                const selected = selectedOptions.includes(opt.intent)
                return (
                  <button
                    key={opt.intent}
                    onClick={() => toggleOption(opt.intent)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 ${KIT.radiusSm} border text-left text-[12px] font-medium transition-colors ${
                      selected
                        ? `${KIT.accentBg} ${KIT.accentBorder} ${KIT.accentText}`
                        : 'bg-white/[0.02] border-white/[0.07] text-zinc-400 hover:border-white/[0.14] hover:text-zinc-200'
                    }`}
                  >
                    <span className={`w-3.5 h-3.5 ${KIT.radiusXs} flex-shrink-0 border flex items-center justify-center transition-colors ${
                      selected ? `${KIT.accentBg} ${KIT.accentBorder}` : 'border-white/[0.14] bg-white/[0.03]'
                    }`}>
                      {selected && <Check className={`w-2.5 h-2.5 ${KIT.accentText}`} />}
                    </span>
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </div>

          <KitField label="Or describe your own use case">
            <KitTextarea
              value={customIntent}
              onChange={e => setCustomIntent(e.target.value)}
              placeholder={`e.g. "Generate personalised size recommendations using AI…"`}
              rows={2}
            />
          </KitField>

          {submitError && <p className="text-[11.5px] text-rose-300">{submitError}</p>}
          {!canActivate && (
            <p className="text-[11px] text-zinc-600">
              Select at least one option or describe your use case.
            </p>
          )}
        </div>
      )}

      {done && (
        <div className="space-y-3">
          <p className="text-[11.5px] text-zinc-500 leading-snug">
            Your key is stored securely. To wire up the features, hand this prompt to
            your coding agent (Claude Code, Cursor; set up in Connect):
          </p>
          <div className={`${KIT.radiusSm} bg-[#0f1015] border ${KIT.border} px-3 py-2.5`}>
            <p className="text-[11.5px] text-zinc-300 font-mono leading-relaxed break-words">
              {buildFinalIntent()}
            </p>
          </div>
        </div>
      )}
    </KitModal>
  )
}

// ─── Connector card ───────────────────────────────────────────────────────────
// A directory is browsed, not scanned down a column: each connector gets a card
// with room for the logo, the name, and enough prose to decide, with the
// category and connection state pinned to a footer strip so every card in the
// grid ends on the same line.

function ConnectorCard({
  provider,
  category,
  onOpen,
}: {
  provider: Provider
  category: IntegrationCategory
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group flex h-full flex-col overflow-hidden text-left ${KIT.surface} border ${KIT.border} ${KIT.radius} ${KIT.inset} transition-colors ${KIT.borderHover} focus:outline-none focus:ring-2 focus:ring-violet-400/35`}
    >
      <div className="flex flex-1 flex-col p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <ProviderMark provider={provider} category={category} size="lg" />
          {provider.enabled && <KitBadge tone="operational">connected</KitBadge>}
        </div>

        <h3 className="text-[13px] font-semibold leading-tight text-zinc-50">{provider.name}</h3>
        <p className="mt-1.5 text-[12px] leading-5 text-zinc-500">{provider.description}</p>
      </div>

      <div className={`flex items-center justify-between gap-3 border-t ${KIT.hairline} px-4 py-2.5`}>
        <span className="truncate font-mono text-[10.5px] text-zinc-600">{category.title}</span>
        <span className="flex flex-shrink-0 items-center gap-1 text-[11px] font-medium text-zinc-600 transition-colors group-hover:text-zinc-200">
          {provider.enabled ? 'Manage' : 'Connect'}
          <ChevronRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>
    </button>
  )
}

// ─── Connector detail (Overview / Connections / Features) ───────────────────────

function ConnectorDetail({
  entry,
  onBack,
  onAddConnection,
}: {
  entry: { provider: Provider; category: IntegrationCategory }
  onBack: () => void
  onAddConnection: () => void
}) {
  const { provider, category } = entry
  return (
    <div className="max-w-3xl">
      <div className="flex items-center gap-1.5 text-[12.5px] mb-4">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-zinc-500 hover:text-zinc-200 transition-colors focus:outline-none"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Integrations
        </button>
        <ChevronRight className="w-3.5 h-3.5 text-zinc-700" />
        <span className="text-zinc-100 font-medium">{provider.name}</span>
      </div>

      <KitCard className="mb-6">
        <div className="flex items-center gap-3.5 px-4 py-4">
          <ProviderMark provider={provider} category={category} size="lg" />
          <div className="flex-1 min-w-0">
            <h2 className="text-[15px] font-semibold text-zinc-50 leading-tight tracking-[-0.01em]">
              {provider.name}
            </h2>
            <p className="text-[12px] text-zinc-500 mt-0.5">{provider.tagline}</p>
          </div>
          <KitBadge tone={provider.enabled ? 'operational' : 'neutral'}>
            {provider.enabled ? 'connected' : 'not connected'}
          </KitBadge>
        </div>
      </KitCard>

      <section className="mb-6">
        <SectionTitle title="Overview" />
        <p className="text-[12.5px] text-zinc-400 leading-relaxed -mt-2">{category.description}</p>
      </section>

      <section className="mb-6">
        <SectionTitle
          title="Connections"
          description={`Create and manage connections for ${provider.name}.`}
          actions={
            <KitButton variant="primary" size="sm" icon={Plus} onClick={onAddConnection}>
              Add connection
            </KitButton>
          }
        />
        {provider.enabled && provider.keyStatus ? (
          <KitCard>
            <div className="flex items-center justify-between px-4 py-3">
              <div className="min-w-0">
                <p className="text-[12.5px] font-medium text-zinc-200 font-mono">{provider.envVar}</p>
                <p className="text-[11.5px] text-zinc-500 font-mono mt-0.5">{provider.keyStatus.maskedKey}</p>
              </div>
              <KitBadge tone="operational">connected</KitBadge>
            </div>
          </KitCard>
        ) : (
          <KitCard>
            <EmptyState
              icon={Info}
              title="No connections"
              description={`Add a connection to store your ${provider.name} key and unlock provisioning.`}
              className="py-8"
            />
          </KitCard>
        )}
      </section>

      <section>
        <SectionTitle
          title="Features"
          description={`What ${provider.name} provisions when connected.`}
        />
        <KitChecklist items={provider.provisions} />
      </section>
    </div>
  )
}

// ─── Panel ─────────────────────────────────────────────────────────────────────

export function IntegrationsPanel() {
  const params = useParams()
  const projectId = params.id as string

  const [categories, setCategories] = useState<IntegrationCategory[]>(INTEGRATION_CATALOG)
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'enabled' | string>('all')
  const [detail, setDetail] = useState<{ provider: Provider; category: IntegrationCategory } | null>(null)
  const [modalOpen, setModalOpen] = useState(false)

  const fetchIntegrations = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/integrations`)
      if (!res.ok) { setFetchError(true); return }
      const { integrations, keyVault } = await res.json() as {
        integrations: Record<string, { enabled: boolean }>
        keyVault: Record<string, { maskedKey: string; connectedAt: string }>
      }

      setFetchError(false)
      setCategories(INTEGRATION_CATALOG.map((cat) => ({
        ...cat,
        providers: cat.providers.map((provider) => ({
          ...provider,
          enabled: integrations[provider.id]?.enabled ?? false,
          keyStatus: keyVault[provider.id] ?? undefined,
          ...(provider.webhookKey ? {
            webhookKey: {
              ...provider.webhookKey,
              keyStatus: keyVault[provider.webhookKey.vaultId] ?? undefined,
            },
          } : {}),
        })),
      })))
    } catch {
      // fall back to the static catalog, but say so
      setFetchError(true)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    fetchIntegrations()
  }, [fetchIntegrations])

  function handleProviderActivated(providerId: string) {
    setCategories(prev => prev.map(cat => ({
      ...cat,
      providers: cat.providers.map(p =>
        p.id === providerId ? { ...p, enabled: true } : p
      ),
    })))
    setTimeout(() => fetchIntegrations(), 1800)
  }

  const allProviders = categories.flatMap((c) => c.providers.map((p) => ({ provider: p, category: c })))
  const totalEnabled = allProviders.filter((x) => x.provider.enabled).length

  // Keep the open detail view in sync with refetched enabled / keyStatus state.
  useEffect(() => {
    setDetail((prev) => {
      if (!prev) return prev
      const fresh = allProviders.find((x) => x.provider.id === prev.provider.id)
      return fresh ?? prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories])

  const q = query.trim().toLowerCase()
  const visible = allProviders.filter(({ provider, category }) => {
    if (filter === 'enabled' && !provider.enabled) return false
    if (filter !== 'all' && filter !== 'enabled' && category.id !== filter) return false
    if (q && !`${provider.name} ${provider.tagline}`.toLowerCase().includes(q)) return false
    return true
  })

  return (
    <div className="px-8 py-6">
      {detail ? (
        <ConnectorDetail
          entry={detail}
          onBack={() => setDetail(null)}
          onAddConnection={() => setModalOpen(true)}
        />
      ) : (
        // Wider than a reading column: a browseable grid wants three cards
        // across on a laptop, and max-w-4xl only ever fit two.
        <div className="max-w-6xl">
          {fetchError && (
            <div className="mb-4">
              <KitNote
                tone="danger"
                icon={Info}
                actions={<KitButton size="sm" variant="secondary" onClick={() => fetchIntegrations()}>Retry</KitButton>}
              >
                Couldn&apos;t load connection status. Showing the catalog without live state.
              </KitNote>
            </div>
          )}

          <div className="flex items-center justify-between gap-4 mb-3">
            <div className="relative w-72">
              <Search className="w-3.5 h-3.5 text-zinc-600 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <KitInput
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search connectors"
                className="pl-9"
              />
            </div>
            <div className="flex items-center gap-4">
              <span className="font-mono text-[10.5px] font-medium tabular-nums text-zinc-500">
                {totalEnabled} connected · {allProviders.length} available
              </span>
              <a
                href="mailto:hello@backenly.com?subject=Connector%20request"
                className="text-[11.5px] font-medium text-zinc-500 hover:text-zinc-200 transition-colors"
              >
                Request a connector
              </a>
            </div>
          </div>

          <KitTabs className="mb-4">
            <KitTab active={filter === 'all'} onClick={() => setFilter('all')} count={allProviders.length}>
              All
            </KitTab>
            <KitTab active={filter === 'enabled'} onClick={() => setFilter('enabled')} count={totalEnabled}>
              Connected
            </KitTab>
            {categories.map((cat) => (
              <KitTab
                key={cat.id}
                active={filter === cat.id}
                onClick={() => setFilter(cat.id)}
                count={cat.providers.length}
              >
                {cat.title}
              </KitTab>
            ))}
          </KitTabs>

          {loading ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className={`${KIT.surface} border ${KIT.border} ${KIT.radius} p-4`}>
                  <div className={`h-10 w-10 ${KIT.radiusSm} animate-pulse bg-white/[0.03]`} />
                  <div className="mt-3 h-3 w-24 animate-pulse rounded bg-white/[0.04]" />
                  <div className="mt-2 h-2.5 w-full animate-pulse rounded bg-white/[0.03]" />
                  <div className="mt-1.5 h-2.5 w-3/4 animate-pulse rounded bg-white/[0.03]" />
                </div>
              ))}
            </div>
          ) : visible.length === 0 ? (
            <KitCard>
              <EmptyState
                icon={Search}
                title="No connectors match"
                description={
                  q
                    ? `Nothing matches “${query}”. Try a different search or request the connector you need.`
                    : filter === 'enabled'
                      ? 'Nothing is connected yet. Pick a connector from the catalog to get started.'
                      : 'No connectors in this category yet.'
                }
              />
            </KitCard>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {visible.map(({ provider, category }) => (
                <ConnectorCard
                  key={provider.id}
                  provider={provider}
                  category={category}
                  onOpen={() => setDetail({ provider, category })}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Activation modal (opened from a connector's "Add connection") */}
      {modalOpen && detail && (
        <ActivationModal
          provider={detail.provider}
          category={detail.category}
          projectId={projectId}
          onClose={() => setModalOpen(false)}
          onActivated={(id) => { handleProviderActivated(id); setModalOpen(false) }}
        />
      )}
    </div>
  )
}
