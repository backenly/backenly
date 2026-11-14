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
 * Presentation composes components/inspector/kit.tsx. The panel renders the
 * whole page, header included, because the header's action and count belong
 * to the directory and the detail view replaces it.
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
  ArrowLeft,
  ExternalLink,
  BarChart2,
  Search,
  Plus,
  Info,
  KeyRound,
  Lock,
  MessageSquare,
  Bell,
  Clapperboard,
  Plug,
} from 'lucide-react'
import {
  BUTTON_BASE,
  BUTTON_VARIANTS,
  CopyButton,
  EmptyState,
  KitButton,
  KitChecklist,
  KitField,
  KitInput,
  KitModal,
  KitNote,
  KitTextarea,
  PageHeader,
  SectionTitle,
  Skeleton,
  StatusDot,
} from '@/components/inspector/kit'
import { FOCUS, PAGE_GUTTER, PAGE_WIDTH } from '@/components/console/tokens'
import { getProject } from '@/lib/api/projects'
import {
  integrationCatalog,
  type CatalogProvider,
  type SecondaryCredential,
} from './integration-catalog'

// ─── Brand logos ────────────────────────────────────────────────────────────────
// Official marks (simple-icons, CC0), pasted verbatim from the package so a mark
// is the real one and not an approximation. Verify with:
//   curl -s https://cdn.jsdelivr.net/npm/simple-icons@13/icons/<slug>.svg
// OpenAI and Resend were hand-simplified variants until 2026-07-30 — Resend's in
// particular rendered as a shape that was not its R.
//
// Rendered with currentColor; the brand hex is applied to the glyph only, never
// to surfaces or chrome. The hex is NOT always the one simple-icons publishes:
// those are chosen for light backgrounds, and OpenAI, Resend and PostHog are all
// black there, which is invisible on our dark tile. A black-on-light mark
// renders white here; PostHog and Anthropic use their own brand colour, which
// carries on dark.

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
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
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
      <path d="M2.023 0v24h5.553v-8.434h2.998L15.326 24h6.65l-5.372-9.258a7.652 7.652 0 0 0 3.316-3.016c.709-1.21 1.062-2.57 1.062-4.08 0-1.462-.353-2.767-1.062-3.91-.709-1.165-1.692-2.079-2.95-2.742C15.737.331 14.355 0 12.823 0Zm5.553 4.87h4.219c.731 0 1.349.125 1.851.376.526.252.925.618 1.2 1.098.274.457.412.994.412 1.611S15.132 9.12 14.88 9.6c-.229.48-.572.856-1.03 1.13-.434.252-.948.38-1.542.38H7.576Z" />
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
  /** What the provider said about the stored key — never fold into a
   *  boolean "connected": a rejected key rendering green is how dead
   *  credentials sit unnoticed until a function fails with them. */
  verification?: 'verified' | 'rejected' | 'unverifiable' | 'unreachable' | 'unchecked'
  verificationDetail?: string
}

/** Tone + label for a stored key, from the provider's own verdict. */
function keyVerificationBadge(status?: KeyVaultStatus): { tone: 'operational' | 'failed' | 'attention' | 'neutral'; label: string } {
  switch (status?.verification) {
    case 'verified':     return { tone: 'operational', label: 'Connected · key confirmed' }
    case 'rejected':     return { tone: 'failed', label: 'Key rejected by the provider' }
    case 'unreachable':  return { tone: 'attention', label: 'Stored · provider unreachable' }
    case 'unverifiable': return { tone: 'neutral', label: 'Stored · cannot be confirmed' }
    default:             return { tone: 'neutral', label: 'Stored · not yet checked' }
  }
}

interface WebhookKeyConfig extends SecondaryCredential {
  /** Filled in at runtime from keyVault response */
  keyStatus?: KeyVaultStatus
}

/**
 * The second credential a connected provider still needs, or null.
 *
 * Stripe's card read "Connected · key confirmed" from the secret key alone
 * while its receiver answered 401 to every event: the signing secret's status
 * was loaded and never shown. A provider is connected only with both.
 */
function missingSecondCredential(provider: Provider): WebhookKeyConfig | null {
  const second = provider.webhookKey
  return provider.enabled && second && !second.keyStatus ? second : null
}

/** A connected provider's status: its key's, unless a credential it needs is missing. */
function connectedBadge(provider: Provider): { tone: 'operational' | 'failed' | 'attention' | 'neutral'; label: string } {
  const missing = missingSecondCredential(provider)
  // A key the provider rejected is the bigger problem, and says so.
  if (missing && provider.keyStatus?.verification !== 'rejected') return { tone: 'attention', label: `${missing.label} missing` }
  return provider.keyStatus ? keyVerificationBadge(provider.keyStatus) : { tone: 'operational', label: 'Connected' }
}

interface Provider extends Omit<CatalogProvider, 'webhookKey'> {
  /** Official brand mark — falls back to the category icon if omitted */
  logo?: React.ComponentType<{ className?: string; style?: React.CSSProperties }>
  enabled: boolean
  keyStatus?: KeyVaultStatus
  /** Optional secondary credential (Stripe's webhook secret, OneSignal's App ID) */
  webhookKey?: WebhookKeyConfig
}

interface IntegrationCategory {
  id: string
  title: string
  description: string
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>
  providers: Provider[]
}

// ─── Catalog ──────────────────────────────────────────────────────────────────
// Which providers are offered, and under which category, is the registry's
// (components/hub/integration-catalog.ts): the same list the MCP integrations
// tool and the functions runtime serve. Only the marks are added here; a
// provider without an official mark shows its category's icon.

const LOGOS: Record<string, React.ComponentType<LogoProps>> = {
  stripe: StripeLogo,
  resend: ResendLogo,
  openai: OpenAILogo,
  anthropic: AnthropicLogo,
  posthog: PostHogLogo,
}

const CATEGORY_ICONS: Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  payments: CreditCard,
  email: Mail,
  sms: MessageSquare,
  push: Bell,
  ai: Brain,
  video: Clapperboard,
  analytics: BarChart2,
  other: Plug,
}

const INTEGRATION_CATALOG: IntegrationCategory[] = integrationCatalog().map((cat) => ({
  id: cat.id,
  title: cat.title,
  description: cat.description,
  icon: CATEGORY_ICONS[cat.id] ?? Plug,
  providers: cat.providers.map((provider) => ({ ...provider, logo: LOGOS[provider.id], enabled: false })),
}))

// ─── Provider logomark ────────────────────────────────────────────────────────
// A neutral tile; the brand hex lives on the glyph only.

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
  const box = size === 'lg' ? 'h-[44px] w-[44px] rounded-[10px]' : 'h-[36px] w-[36px] rounded-[8px]'
  const glyph = size === 'lg' ? 'h-[22px] w-[22px]' : 'h-[18px] w-[18px]'
  return (
    <div
      className={`${box} flex flex-shrink-0 items-center justify-center border border-white/[0.09] bg-[linear-gradient(180deg,rgba(255,255,255,0.06),rgba(255,255,255,0.02))] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]`}
    >
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
  apiBase,
  onClose,
  onActivated,
}: {
  provider: Provider
  category: IntegrationCategory
  projectId: string
  apiBase: ApiBase
  onClose: () => void
  onActivated: (providerId: string) => void
}) {
  const [step, setStep] = useState<1 | 2>(1)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [keyError, setKeyError] = useState('')
  const [webhookKey, setWebhookKey] = useState('')
  const [showWebhookKey, setShowWebhookKey] = useState(false)
  const [webhookKeyError, setWebhookKeyError] = useState('')
  // The provider's answer about the key, asked on Continue (checking), so a
  // refused key is said on this step rather than after the next one.
  const [checking, setChecking] = useState(false)
  const [keyCheck, setKeyCheck] = useState<{ status: string; detail: string } | null>(null)
  const [selectedOptions, setSelectedOptions] = useState<string[]>([])
  const [customIntent, setCustomIntent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [done, setDone] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus the key input when the modal opens
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 80)
    return () => clearTimeout(t)
  }, [])

  function validateKey() {
    const trimmed = apiKey.trim()
    if (!trimmed) { setKeyError('Paste your API key to continue.'); return false }
    if (trimmed.length < 10) { setKeyError('This doesn’t look like a valid API key. Check that you copied all of it.'); return false }
    setKeyError('')
    return true
  }

  async function handleStep1Continue() {
    if (!validateKey() || checking) return
    setChecking(true)
    setWebhookKeyError('')
    setKeyCheck(null)
    try {
      const values: Record<string, string> = { [provider.envVar]: apiKey.trim() }
      if (provider.webhookKey && webhookKey.trim()) values[provider.webhookKey.envVar] = webhookKey.trim()
      const res = await fetch(`/api/projects/${projectId}/credentials/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ integrationId: provider.id, values }),
      })
      const data = await res.json().catch(() => ({}))
      // A key storing would refuse is said here, under its own field.
      if (res.status === 422) {
        const message = data.error || 'This key was refused.'
        if (provider.webhookKey && data.envVar === provider.webhookKey.envVar) setWebhookKeyError(message)
        else setKeyError(message)
        return
      }
      const main = res.ok && Array.isArray(data.checks)
        ? data.checks.find((c: { envVar: string }) => c.envVar === provider.envVar)
        : null
      if (main) setKeyCheck({ status: main.status, detail: main.detail })
      // Any other answer (offline, a limit, a server error) doesn't stop here:
      // connecting checks the key again before it is stored.
      setStep(2)
    } catch {
      setStep(2)
    } finally {
      setChecking(false)
    }
  }

  function toggleOption(intent: string) {
    setSelectedOptions(prev =>
      prev.includes(intent) ? prev.filter(i => i !== intent) : [...prev, intent]
    )
  }

  /**
   * The prompt handed to the user's coding agent once the key is stored.
   *
   * It used to be the bare intent ("Add subscription billing…"). An agent
   * sitting in the user's app repo reads that as a request to write Stripe code
   * in the repo, asks for the key again, and builds nothing in Backenly. So the
   * prompt says where the work belongs, which door to use (with the CLI for a
   * conversation whose MCP tools have not loaded yet), and that the key is
   * already stored and must stay out of code.
   */
  function buildFinalIntent(): string {
    const parts: string[] = [...selectedOptions]
    if (customIntent.trim()) parts.push(customIntent.trim())
    const intent =
      parts.length === 0 ? `Add the ${provider.name} integration`
      : parts.length === 1 ? parts[0]
      : parts.join('. ')
    return (
      `In my Backenly backend (project ${projectId}): ${intent.replace(/\.$/, '')}. ` +
      `Build it in Backenly with its tools: backend_chat over MCP, or ` +
      `npx -y @backenly/cli@latest chat "…" if the MCP tools are not loaded in this conversation. ` +
      `My ${provider.name} key is already stored in Backenly and Backenly functions reach it as ` +
      `ctx.integrations.${provider.id}. Do not ask me for the key and do not put it in code.`
    )
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
        setSubmitError(credData.error || 'Your API key could not be saved. Try again.')
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

  return (
    <KitModal
      open
      onClose={onClose}
      width="max-w-[520px]"
      title={
        <span className="flex items-center gap-3">
          <ProviderMark provider={provider} category={category} />
          {done ? `${provider.name} connected` : `Connect ${provider.name}`}
        </span>
      }
      description={done ? undefined : <StepIndicator step={step} />}
      footer={
        done ? (
          <>
            <CopyButton value={buildFinalIntent()} label="Copy prompt" showLabel className="h-[32px] border border-white/[0.10] px-3" />
            <KitButton variant="primary" onClick={onClose}>Done</KitButton>
          </>
        ) : step === 1 ? (
          <KitButton variant="primary" iconRight={ChevronRight} onClick={handleStep1Continue} loading={checking} disabled={!apiKey.trim()}>
            {checking ? `Checking with ${provider.name}…` : 'Continue'}
          </KitButton>
        ) : (
          <>
            <KitButton variant="ghost" icon={ArrowLeft} onClick={() => { setStep(1); setSubmitError('') }}>
              Back
            </KitButton>
            <KitButton variant="primary" icon={Zap} loading={submitting} onClick={handleActivate} disabled={!canActivate}>
              {submitting ? 'Connecting…' : `Connect ${provider.name}`}
            </KitButton>
          </>
        )
      }
    >
      {step === 1 && !done && (
        <form
          className="space-y-4"
          onSubmit={e => { e.preventDefault(); handleStep1Continue() }}
        >
          <label className="block">
            <span className="mb-1.5 block font-mono text-[12px] text-zinc-300">{provider.envVar}</span>
            <div className="relative">
              <KitInput
                ref={inputRef}
                name={provider.envVar}
                autoComplete="off"
                spellCheck={false}
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={e => { setApiKey(e.target.value); setKeyError('') }}
                placeholder={provider.keyPlaceholder}
                aria-invalid={!!keyError}
                className={`pr-10 font-mono ${keyError ? '!border-rose-400/50' : ''}`}
              />
              <button
                type="button"
                onClick={() => setShowKey(v => !v)}
                aria-label={showKey ? 'Hide key' : 'Show key'}
                className="absolute right-1.5 top-1/2 flex h-[26px] w-[26px] -translate-y-1/2 items-center justify-center rounded-[6px] text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
              >
                {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
            {keyError && <p role="alert" className="mt-1.5 text-[12px] text-rose-300">{keyError}</p>}
          </label>

          <a
            href={provider.keyDocsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-fit items-center gap-1.5 text-[12.5px] text-zinc-400 transition-colors hover:text-zinc-100"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {provider.keyHelperText}
          </a>

          {provider.webhookKey && (
            <div className="border-t border-white/[0.06] pt-4">
              <label className="block">
                <span className="mb-1.5 flex items-baseline gap-2">
                  <span className="font-mono text-[12px] text-zinc-300">{provider.webhookKey.envVar}</span>
                  <span className="text-[12px] text-faint">Can be added later</span>
                </span>
                <div className="relative">
                  <KitInput
                    name={provider.webhookKey.envVar}
                    autoComplete="off"
                    spellCheck={false}
                    type={showWebhookKey ? 'text' : 'password'}
                    value={webhookKey}
                    onChange={e => { setWebhookKey(e.target.value); setWebhookKeyError('') }}
                    placeholder={provider.webhookKey.placeholder}
                    aria-invalid={!!webhookKeyError}
                    className={`pr-10 font-mono ${webhookKeyError ? '!border-rose-400/50' : ''}`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowWebhookKey(v => !v)}
                    aria-label={showWebhookKey ? 'Hide secret' : 'Show secret'}
                    className="absolute right-1.5 top-1/2 flex h-[26px] w-[26px] -translate-y-1/2 items-center justify-center rounded-[6px] text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
                  >
                    {showWebhookKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
                {webhookKeyError && <p role="alert" className="mt-1.5 text-[12px] text-rose-300">{webhookKeyError}</p>}
              </label>
              {/* It read "Optional, add after deploying" while the receiver refused every event without it. */}
              <p className="mt-2 text-[12px] leading-[18px] text-amber-200/80">{provider.webhookKey.missingMeans}</p>
              {provider.webhookKey.endpointPath && (
                <div className="mt-3">
                  <p className="mb-1.5 text-[12px] text-zinc-400">Endpoint URL to add in {provider.name}:</p>
                  <EndpointUrl apiBase={apiBase} path={provider.webhookKey.endpointPath} />
                </div>
              )}
              <a
                href={provider.webhookKey.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 flex w-fit items-center gap-1.5 text-[12.5px] text-zinc-400 transition-colors hover:text-zinc-100"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {provider.webhookKey.helperText}
              </a>
            </div>
          )}

          <p className="flex items-start gap-2 text-[12px] leading-[18px] text-faint">
            <Lock className="mt-[2px] h-3.5 w-3.5 flex-shrink-0" />
            Encrypted with AES-256-GCM, and never sent back to the browser after this step.
          </p>
        </form>
      )}

      {step === 2 && !done && (
        <div className="space-y-4">
          {keyCheck && (
            <KitNote icon={keyCheck.status === 'verified' ? Check : Info} tone={keyCheck.status === 'verified' ? 'success' : 'info'}>
              {keyCheck.detail}
            </KitNote>
          )}
          <fieldset>
            <legend className="text-[13px] font-medium text-zinc-100">What should {provider.name} do in this backend?</legend>
            <p className="mb-3 mt-0.5 text-[12.5px] text-faint">
              Pick one or more, or describe it yourself. Your agent builds exactly this in Backenly.
            </p>
            <div className="space-y-1.5">
              {provider.quickOptions.map(opt => {
                const selected = selectedOptions.includes(opt.intent)
                return (
                  <label
                    key={opt.intent}
                    className={`flex cursor-pointer items-center gap-2.5 rounded-[8px] border px-3 py-2.5 text-[13px] transition-colors focus-within:ring-2 focus-within:ring-violet-300/60 ${
                      selected
                        ? 'border-violet-300/40 bg-violet-400/[0.06] text-zinc-100'
                        : 'border-white/[0.08] text-zinc-300 hover:border-white/[0.14]'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleOption(opt.intent)}
                      className="sr-only"
                    />
                    <span
                      aria-hidden
                      className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-[4px] border transition-colors ${
                        selected ? 'border-violet-300/60 bg-violet-400/80' : 'border-white/[0.18] bg-white/[0.03]'
                      }`}
                    >
                      {selected && <Check className="h-3 w-3 text-zinc-950" strokeWidth={3} />}
                    </span>
                    {opt.label}
                  </label>
                )
              })}
            </div>
          </fieldset>

          <KitField label="Or describe your own use case">
            <KitTextarea
              value={customIntent}
              onChange={e => setCustomIntent(e.target.value)}
              placeholder="Generate size recommendations from order history…"
              rows={2}
            />
          </KitField>

          {submitError && <p role="alert" className="text-[12.5px] text-rose-300">{submitError}</p>}
        </div>
      )}

      {done && (
        <div className="space-y-3">
          <p className="text-[13px] leading-[20px] text-zinc-400">
            Your key is stored. To build the features, send this to your coding agent (Claude Code, Cursor, any MCP
            client set up in Connect):
          </p>
          <div className="rounded-[8px] border border-white/[0.08] bg-[#08090a] px-3.5 py-3">
            <p className="break-words font-mono text-[12px] leading-[20px] text-zinc-300">{buildFinalIntent()}</p>
          </div>
        </div>
      )}
    </KitModal>
  )
}

// ─── Second credential, on its own ────────────────────────────────────────────
// Adding Stripe's signing secret later meant reopening the connect dialog,
// whose Continue waited for the secret key again and whose Connect waited for
// something to build. This stores the one credential, beside the stored key.

function SecondCredentialModal({
  provider,
  category,
  projectId,
  apiBase,
  onClose,
  onSaved,
}: {
  provider: Provider
  category: IntegrationCategory
  projectId: string
  apiBase: ApiBase
  onClose: () => void
  onSaved: () => void
}) {
  const second = provider.webhookKey!
  const [value, setValue] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 80)
    return () => clearTimeout(t)
  }, [])

  async function save() {
    const trimmed = value.trim()
    if (!trimmed || saving) return
    setSaving(true)
    setError('')
    try {
      const res = await fetch(`/api/projects/${projectId}/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ integrationId: provider.id, values: { [second.envVar]: trimmed } }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        setError(data.error || `The ${second.label} could not be saved. Try again.`)
        return
      }
      onSaved()
    } catch {
      setError('Network error. Check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <KitModal
      open
      onClose={onClose}
      width="max-w-[520px]"
      title={
        <span className="flex items-center gap-3">
          <ProviderMark provider={provider} category={category} />
          {`${second.keyStatus ? 'Replace' : 'Add'} the ${provider.name} ${second.label}`}
        </span>
      }
      footer={
        <KitButton variant="primary" icon={Check} onClick={save} loading={saving} disabled={!value.trim()}>
          {saving ? 'Saving…' : `Save ${second.label}`}
        </KitButton>
      }
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save() }}>
        {second.endpointPath && (
          <div>
            <p className="mb-1.5 text-[12.5px] text-zinc-400">1. Add this endpoint URL in {provider.name}:</p>
            <EndpointUrl apiBase={apiBase} path={second.endpointPath} />
          </div>
        )}
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] text-zinc-400">
            {second.endpointPath ? `2. Paste the ${second.label} ${provider.name} shows for it:` : `Paste the ${second.label}:`}
          </span>
          <div className="relative">
            <KitInput
              ref={inputRef}
              name={second.envVar}
              autoComplete="off"
              spellCheck={false}
              type={show ? 'text' : 'password'}
              value={value}
              onChange={(e) => { setValue(e.target.value); setError('') }}
              placeholder={second.placeholder}
              aria-invalid={!!error}
              className={`pr-10 font-mono ${error ? '!border-rose-400/50' : ''}`}
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              aria-label={show ? 'Hide secret' : 'Show secret'}
              className="absolute right-1.5 top-1/2 flex h-[26px] w-[26px] -translate-y-1/2 items-center justify-center rounded-[6px] text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
            >
              {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
          {error && <p role="alert" className="mt-1.5 text-[12px] text-rose-300">{error}</p>}
        </label>
        <a
          href={second.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex w-fit items-center gap-1.5 text-[12.5px] text-zinc-400 transition-colors hover:text-zinc-100"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {second.helperText}
        </a>
        <p className="flex items-start gap-2 text-[12px] leading-[18px] text-faint">
          <Lock className="mt-[2px] h-3.5 w-3.5 flex-shrink-0" />
          Encrypted with AES-256-GCM, and never sent back to the browser after this step.
        </p>
      </form>
    </KitModal>
  )
}

/** The activation's two steps. Numbered because they are a sequence. */
function StepIndicator({ step }: { step: 1 | 2 }) {
  const steps = ['Add your key', 'Choose what to build']
  return (
    <ol className="mt-1 flex items-center gap-2 text-[12.5px]">
      {steps.map((label, i) => {
        const n = i + 1
        const state = n < step ? 'done' : n === step ? 'current' : 'next'
        return (
          <li key={label} className="flex items-center gap-2">
            {i > 0 && <span aria-hidden className="h-px w-5 bg-white/[0.12]" />}
            <span
              aria-hidden
              className={`flex h-[18px] w-[18px] items-center justify-center rounded-full text-[11px] font-semibold tabular-nums ${
                state === 'done'
                  ? 'bg-emerald-400/15 text-emerald-300'
                  : state === 'current'
                    ? 'bg-zinc-100 text-zinc-950'
                    : 'border border-white/[0.14] text-faint'
              }`}
            >
              {state === 'done' ? <Check className="h-3 w-3" strokeWidth={3} /> : n}
            </span>
            <span className={state === 'next' ? 'text-faint' : 'text-zinc-200'} aria-current={state === 'current' ? 'step' : undefined}>
              {label}
            </span>
          </li>
        )
      })}
    </ol>
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
      className={`group flex h-full flex-col overflow-hidden rounded-[10px] border border-white/[0.08] bg-[#0f1012] text-left transition-[border-color,background-color] duration-150 hover:border-white/[0.15] hover:bg-[#111215] ${FOCUS}`}
    >
      <div className="flex flex-1 flex-col p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <ProviderMark provider={provider} category={category} size="lg" />
          {provider.enabled && <StatusDot tone={connectedBadge(provider).tone} label={connectedBadge(provider).label} />}
        </div>

        <h3 className="text-[14px] font-semibold leading-[20px] tracking-[-0.01em] text-zinc-50">{provider.name}</h3>
        <p className="mt-1.5 line-clamp-3 text-[13px] leading-[20px] text-zinc-400">{provider.description}</p>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] px-5 py-3">
        <span className="truncate text-[12px] text-faint">{category.title}</span>
        <span className="flex flex-shrink-0 items-center gap-1 text-[12.5px] font-medium text-zinc-400 transition-colors group-hover:text-zinc-100">
          {provider.enabled ? 'Manage' : 'Connect'}
          <ChevronRight className="h-3.5 w-3.5 transition-transform duration-150 group-hover:translate-x-0.5" />
        </span>
      </div>
    </button>
  )
}

// ─── Connector detail ─────────────────────────────────────────────────────────

/** A stored credential: its field name, masked value and what the provider said. */
function CredentialRow({ envVar, status, action }: { envVar: string; status: KeyVaultStatus; action?: React.ReactNode }) {
  const badge = keyVerificationBadge(status)
  return (
    <div className="flex items-center justify-between gap-3 rounded-[10px] border border-white/[0.08] bg-[#0f1012] px-4 py-3.5">
      <div className="min-w-0">
        <p className="font-mono text-[12.5px] text-zinc-100">{envVar}</p>
        <p className="mt-0.5 font-mono text-[12px] text-faint">{status.maskedKey}</p>
        {(status.verification === 'rejected' || status.verification === 'unreachable') && status.verificationDetail && (
          <p className="mt-1 text-[12px] leading-[18px] text-amber-200/80">{status.verificationDetail}</p>
        )}
      </div>
      <div className="flex flex-shrink-0 items-center gap-3">
        <StatusDot tone={badge.tone} label={badge.label} />
        {action}
      </div>
    </div>
  )
}

/** Where the project's API is served, for an endpoint URL: loading, known (null when this server has none), or failed. */
type ApiBase = { state: 'loading' } | { state: 'ready'; url: string | null } | { state: 'failed' }

/**
 * The address a provider sends events to, to paste into the provider. Stripe
 * issues a signing secret only for an endpoint entered in its dashboard, and
 * the console showed this address nowhere.
 */
function EndpointUrl({ apiBase, path }: { apiBase: ApiBase; path: string }) {
  if (apiBase.state === 'loading') return <Skeleton className="h-[46px] w-full rounded-[10px]" />
  if (apiBase.state === 'failed') {
    return <p className="text-[12.5px] leading-[19px] text-faint">The endpoint URL couldn’t be loaded. Reload the page to try again.</p>
  }
  if (!apiBase.url) {
    return (
      <p className="text-[12.5px] leading-[19px] text-faint">
        This server has no API address for the project’s region, so its endpoint URL can’t be shown.
      </p>
    )
  }
  const url = `${apiBase.url.replace(/\/+$/, '')}/${path}`
  return (
    <div className="flex items-center justify-between gap-3 rounded-[10px] border border-white/[0.08] bg-[#0f1012] px-4 py-3">
      <code className="min-w-0 break-all font-mono text-[12.5px] text-zinc-100">{url}</code>
      <CopyButton value={url} label="Copy endpoint URL" />
    </div>
  )
}

function ConnectorDetail({
  entry,
  apiBase,
  onBack,
  onAddConnection,
  onAddSecondCredential,
}: {
  entry: { provider: Provider; category: IntegrationCategory }
  apiBase: ApiBase
  onBack: () => void
  onAddConnection: () => void
  onAddSecondCredential: () => void
}) {
  const { provider, category } = entry
  const second = provider.webhookKey
  return (
    <div className="max-w-[840px] pb-16">
      <nav aria-label="Breadcrumb" className="mb-6 flex items-center gap-1.5 text-[13px]">
        <button
          type="button"
          onClick={onBack}
          className={`flex items-center gap-1.5 rounded-[5px] text-zinc-400 transition-colors hover:text-zinc-100 ${FOCUS}`}
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Integrations
        </button>
        <ChevronRight className="h-3.5 w-3.5 text-zinc-700" />
        <span className="font-medium text-zinc-100" aria-current="page">{provider.name}</span>
      </nav>

      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <ProviderMark provider={provider} category={category} size="lg" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-[22px] font-semibold leading-[28px] tracking-[-0.022em] text-zinc-50">{provider.name}</h1>
              <StatusDot
                tone={!provider.enabled ? 'neutral' : connectedBadge(provider).tone}
                label={!provider.enabled ? 'Not connected' : connectedBadge(provider).label}
              />
            </div>
            <p className="mt-0.5 text-[14px] text-zinc-400">{provider.tagline}</p>
          </div>
        </div>
        <KitButton variant="primary" icon={provider.enabled ? KeyRound : Plus} onClick={onAddConnection}>
          {provider.enabled ? 'Replace key' : 'Connect'}
        </KitButton>
      </div>

      <div className="mt-8 space-y-8">
        <section>
          <SectionTitle title="Connection" description={`The ${provider.name} credential your backend's functions reach as ctx.integrations.${provider.id}.`} />
          {provider.enabled && provider.keyStatus ? (
            <div className="space-y-2">
              <CredentialRow envVar={provider.envVar} status={provider.keyStatus} />
              {second && (second.keyStatus ? (
                <CredentialRow
                  envVar={second.envVar}
                  status={second.keyStatus}
                  action={<KitButton size="sm" variant="ghost" onClick={onAddSecondCredential}>Replace</KitButton>}
                />
              ) : (
                // Added on its own: the connect dialog asked for the key again,
                // and for something to build, before it would store this.
                <div className="flex items-center justify-between gap-3 rounded-[10px] border border-amber-300/25 bg-[#0f1012] px-4 py-3.5">
                  <div className="min-w-0">
                    <p className="font-mono text-[12.5px] text-zinc-100">{second.envVar}</p>
                    <p className="mt-0.5 text-[12px] leading-[18px] text-amber-200/80">Not stored. {second.missingMeans}</p>
                  </div>
                  <KitButton size="sm" variant="secondary" icon={Plus} onClick={onAddSecondCredential}>
                    Add {second.label}
                  </KitButton>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-[10px] border border-white/[0.08] bg-[#0f1012]">
              <EmptyState
                icon={KeyRound}
                title="No key stored"
                description={`Connect ${provider.name} to store its key, encrypted, so your agent can build with it.`}
                className="py-10"
                action={
                  <KitButton variant="secondary" icon={Plus} onClick={onAddConnection}>
                    Connect {provider.name}
                  </KitButton>
                }
              />
            </div>
          )}
        </section>

        {second?.endpointPath && (
          <section>
            <SectionTitle
              title="Receiving events"
              description={
                `${provider.name} sends events to this address. Add it as an endpoint in ${provider.name}, ` +
                `which then shows the ${second.label} to store here.`
              }
            />
            <EndpointUrl apiBase={apiBase} path={second.endpointPath} />
          </section>
        )}

        <section>
          <SectionTitle title="What your agent can build" description={category.description} />
          <div className="rounded-[10px] border border-white/[0.08] bg-[#0f1012] px-4 py-4">
            <KitChecklist items={provider.provisions} />
          </div>
        </section>
      </div>
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
  const [secondModalOpen, setSecondModalOpen] = useState(false)
  // The project's API base as the Connect page gives it out: an operator's
  // override when one is set, else the address of the project's region. An
  // endpoint URL is built from it, never from this page's own origin.
  const [apiBase, setApiBase] = useState<ApiBase>({ state: 'loading' })

  useEffect(() => {
    let live = true
    getProject(projectId).then(
      (project) => {
        if (!live) return
        const url = project.apiUrlProd || project.apiUrlStaging || project.apiUrlDev || project.apiBaseUrl || null
        setApiBase({ state: 'ready', url })
      },
      () => { if (live) setApiBase({ state: 'failed' }) },
    )
    return () => { live = false }
  }, [projectId])

  const fetchIntegrations = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/integrations`)
      if (!res.ok) { setFetchError(true); return }
      const { integrations, keyVault } = await res.json() as {
        integrations: Record<string, { enabled: boolean }>
        keyVault: Record<string, KeyVaultStatus>
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
  // Connected means every credential the provider needs is stored.
  const isConnected = (p: Provider) => p.enabled && !missingSecondCredential(p)
  const totalEnabled = allProviders.filter((x) => isConnected(x.provider)).length
  const needsSetup = allProviders.filter((x) => missingSecondCredential(x.provider)).length
  // The "Needs setup" filter goes once nothing does.
  const activeFilter = filter === 'setup' && needsSetup === 0 ? 'all' : filter

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
    if (activeFilter === 'enabled' && !isConnected(provider)) return false
    if (activeFilter === 'setup' && !missingSecondCredential(provider)) return false
    if (activeFilter !== 'all' && activeFilter !== 'enabled' && activeFilter !== 'setup' && category.id !== activeFilter) return false
    if (q && !`${provider.name} ${provider.tagline}`.toLowerCase().includes(q)) return false
    return true
  })

  const filters: Array<{ id: string; label: string; count: number }> = [
    { id: 'all', label: 'All', count: allProviders.length },
    { id: 'enabled', label: 'Connected', count: totalEnabled },
    ...(needsSetup > 0 ? [{ id: 'setup', label: 'Needs setup', count: needsSetup }] : []),
    ...categories.map((cat) => ({ id: cat.id, label: cat.title, count: cat.providers.length })),
  ]

  return (
    <div className={`${PAGE_WIDTH} ${PAGE_GUTTER}`}>
      {detail ? (
        <div className="pt-7 sm:pt-9">
          <ConnectorDetail
            entry={detail}
            apiBase={apiBase}
            onBack={() => setDetail(null)}
            onAddConnection={() => setModalOpen(true)}
            onAddSecondCredential={() => setSecondModalOpen(true)}
          />
        </div>
      ) : (
        <div className="pb-16">
          <PageHeader
            className="!px-0"
            title="Integrations"
            description="Connect a provider’s key once. It becomes callable from functions, triggers and your agent through ctx.integrations, and never appears in code."
            meta={
              !loading ? (
                <span className="text-[13px] tabular-nums text-faint">
                  {`${totalEnabled} of ${allProviders.length} connected`}
                  {needsSetup > 0 && ` · ${needsSetup} ${needsSetup === 1 ? 'needs' : 'need'} setup`}
                </span>
              ) : undefined
            }
            actions={
              <a
                href="mailto:hello@backenly.com?subject=Connector%20request"
                className={`${BUTTON_BASE} ${BUTTON_VARIANTS.secondary} h-[32px] px-3 text-[13px]`}
              >
                Request a connector
              </a>
            }
          />

          {fetchError && (
            <div className="mb-5">
              <KitNote
                tone="danger"
                icon={Info}
                actions={<KitButton size="sm" variant="secondary" onClick={() => fetchIntegrations()}>Retry</KitButton>}
              >
                Connection status couldn’t be loaded. The catalog is shown without live state.
              </KitNote>
            </div>
          )}

          <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="scrollbar-hide -mx-1 flex items-center gap-1 overflow-x-auto px-1" role="radiogroup" aria-label="Filter connectors">
              {filters.map((f) => {
                const on = activeFilter === f.id
                return (
                  <button
                    key={f.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setFilter(f.id)}
                    className={`inline-flex h-[30px] flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border px-2.5 text-[12.5px] font-medium transition-colors ${FOCUS} ${
                      on
                        ? 'border-white/[0.14] bg-white/[0.08] text-zinc-50'
                        : 'border-transparent text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100'
                    }`}
                  >
                    {f.label}
                    <span className={`tabular-nums ${on ? 'text-zinc-400' : 'text-faint'}`}>{f.count}</span>
                  </button>
                )
              })}
            </div>
            <div className="relative w-full lg:w-[280px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
              <KitInput
                type="search"
                name="connector-search"
                autoComplete="off"
                aria-label="Search connectors"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search connectors…"
                className="pl-9"
              />
            </div>
          </div>

          {loading ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="rounded-[10px] border border-white/[0.08] bg-[#0f1012] p-5">
                  <Skeleton className="h-[44px] w-[44px] rounded-[10px]" />
                  <Skeleton className="mt-4 h-[14px] w-24" />
                  <Skeleton className="mt-3 h-[12px] w-full" />
                  <Skeleton className="mt-2 h-[12px] w-3/4" />
                </div>
              ))}
            </div>
          ) : visible.length === 0 ? (
            <div className="rounded-[10px] border border-white/[0.08] bg-[#0f1012]">
              <EmptyState
                icon={Search}
                title="No connectors match"
                description={
                  q
                    ? `Nothing matches “${query}”. Try a different search, or request the connector you need.`
                    : activeFilter === 'enabled'
                      ? 'Nothing is connected yet. Pick a connector from the catalog to start.'
                      : 'No connectors in this category yet.'
                }
              />
            </div>
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

      {/* Activation modal (opened from a connector's Connect action) */}
      {modalOpen && detail && (
        <ActivationModal
          provider={detail.provider}
          category={detail.category}
          projectId={projectId}
          apiBase={apiBase}
          onClose={() => setModalOpen(false)}
          onActivated={(id) => { handleProviderActivated(id) }}
        />
      )}

      {/* A second credential on its own (opened from the connector's Connection section) */}
      {secondModalOpen && detail?.provider.webhookKey && (
        <SecondCredentialModal
          provider={detail.provider}
          category={detail.category}
          projectId={projectId}
          apiBase={apiBase}
          onClose={() => setSecondModalOpen(false)}
          onSaved={() => { setSecondModalOpen(false); fetchIntegrations() }}
        />
      )}
    </div>
  )
}
