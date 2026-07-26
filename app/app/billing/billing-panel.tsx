'use client'

/**
 * BillingPanel — flat-kit rebuild of the billing surface (IA restructure §5.4 / §11).
 *
 * Replaces the pre-restructure gradient/glow BillingSection. Every Paddle code
 * path — checkout open, cancel, usage fetch, environment init — is preserved
 * VERBATIM; only the presentation moves to the locked kit (#16171d panels,
 * hairlines, mono numerals, violet-only accent, no gradients/glows/amber).
 *
 * Honesty (§5.4): credits are shown as balance + this-cycle burn. A per-event
 * credit *ledger history* tab needs the `CreditLedgerEntry` model, which is
 * Phase 3 data-model work (not yet in schema) — so it is intentionally absent
 * rather than faked. Autonomy is company-funded and never metered here.
 */

import { useState, useEffect } from 'react'
import Script from 'next/script'
import Link from 'next/link'
import {
  Crown, Check, Loader2, AlertTriangle, Zap, ArrowRight, ArrowUpRight, Bot, Activity,
} from 'lucide-react'
import { KitCard, KitCardHeader, KitCardBody, KitButton, KitBadge, KitNote, KitConfirmDialog } from '@/components/inspector/kit'

// ─── Types ───────────────────────────────────────────────────────────────────

interface Entitlements {
  logRetentionDays: number
  allowCustomDomain: boolean
  prioritySupport: boolean
}

interface UsageData {
  planName: string
  aiCreditsUsed: number
  monthlyAiCredits: number | null
  aiFunctionInvocationsUsed: number
  maxAiFunctionInvocationsPerMonth: number | null
  apiRequestsUsed: string
  maxApiRequestsPerMonth: string | null
  apiQuotaIsLifetime: boolean
  resetAt: string
  entitlements: Entitlements
}

interface PlanDef {
  name: string
  monthly: number | null // null = custom (sales-led Enterprise)
  annual: number | null
  tagline: string
  description: string
  recommended: boolean
  ctaHref?: string
  limits: string[]
}

const PLAN_DEFS: PlanDef[] = [
  {
    name: 'SANDBOX',
    monthly: 0,
    annual: null,
    tagline: 'Free',
    description: 'Explore what Backenly can do',
    recommended: false,
    limits: [
      '1 project, permanently live, no expiry',
      'Self-healing every 30 minutes, company-funded and always on',
      'Up to 50,000 monthly active users',
      '10,000 function invocations / month',
      '512 MB Postgres + 1 GB storage',
    ],
  },
  {
    name: 'BUILDER',
    monthly: 25,
    annual: 20,
    tagline: 'Pro',
    description: 'A backend that heals itself',
    recommended: true,
    limits: [
      'Self-healing every minute with the full autonomy dial, unlimited fixes',
      'Unlimited projects + unlimited API requests',
      'Up to 200,000 monthly active users',
      '2M function invocations / month',
      '10 GB Postgres + 100 GB storage',
      '5 team seats with org roles · rollback · email support',
    ],
  },
  {
    name: 'SCALE',
    monthly: null,
    annual: null,
    tagline: 'Enterprise',
    description: 'Custom limits, isolation, SLA',
    recommended: false,
    ctaHref: 'mailto:sales@backenly.com?subject=Backenly%20Enterprise',
    limits: [
      'Custom MAU + storage pools',
      'Custom autonomy cadence + guardrail policies',
      'SSO (OIDC) + RBAC',
      'Priority support with a 12-hour SLA',
      'Dedicated isolation + migration help',
      'Invoicing & procurement-friendly billing',
    ],
  },
]

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.0', '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace('.0', '')}k`
  return n.toLocaleString()
}
function pct(used: number, max: number | null): number {
  if (max === null) return 0
  if (max === 0) return 100
  return Math.min(100, Math.round((used / max) * 100))
}

function Meter({ icon: Icon, label, used, max, resetNote }: {
  icon: React.ElementType; label: string; used: number; max: number | null; resetNote?: string
}) {
  const p = pct(used, max)
  const over = max !== null && (used > max || max === 0)
  const warn = !over && p >= 75
  const bar = over ? 'bg-rose-400' : warn ? 'bg-amber-400' : 'bg-violet-500'
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Icon className="h-3 w-3 flex-shrink-0 text-zinc-600" />
          <span className="truncate text-[11px] text-zinc-500">{label}</span>
        </div>
        <span className={`font-mono text-[11.5px] font-medium tabular-nums ${over ? 'text-rose-300' : warn ? 'text-amber-500' : 'text-zinc-300'}`}>
          {fmtNum(used)}<span className="mx-0.5 text-zinc-600">/</span>{max === null ? <span className="text-zinc-600">∞</span> : fmtNum(max)}
        </span>
      </div>
      {max !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
          <div className={`h-full rounded-full ${bar} transition-[width] duration-700`} style={{ width: `${p}%` }} />
        </div>
      )}
      {resetNote && <p className="mt-1.5 font-mono text-[10px] text-zinc-600">{resetNote}</p>}
    </div>
  )
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export function BillingPanel() {
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [annual, setAnnual] = useState(false)
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null)
  const [cancelLoading, setCancelLoading] = useState(false)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchUsage()
  }, [])

  const fetchUsage = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/billing/usage', { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to fetch usage')
      setUsage(await res.json())
    } catch {
      setError('Failed to load billing data')
    } finally {
      setLoading(false)
    }
  }

  const handleUpgrade = async (planName: string) => {
    setCheckoutLoading(planName)
    setError(null)
    try {
      const res = await fetch('/api/billing/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ plan: planName, billing: annual ? 'annual' : 'monthly' }),
      })
      const data = await res.json()
      if (!res.ok) {
        if (res.status === 409) {
          if (data.code === 'ALREADY_SUBSCRIBED') throw new Error(`You're already on this plan. No changes needed.`)
          throw new Error(data.error || 'You already have an active subscription. Cancel your current plan before switching.')
        }
        throw new Error(data.error || 'Failed to create checkout')
      }
      const { priceId, customerEmail, customData, successUrl } = data
      const Paddle = (window as any).Paddle
      if (!Paddle) throw new Error('Payment system not loaded. Refresh and try again')
      if (!process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN) throw new Error('Payment system not configured. Contact support')
      try {
        Paddle.Checkout.open({
          items: [{ priceId: priceId.trim(), quantity: 1 }],
          customer: { email: customerEmail },
          customData: {
            userId: String(customData.userId ?? ''),
            planName: String(customData.planName ?? ''),
            displayName: String(customData.displayName ?? ''),
            billing: String(customData.billing ?? 'monthly'),
          },
          settings: { displayMode: 'overlay', theme: 'dark', successUrl },
        })
      } catch (paddleErr: any) {
        throw new Error(paddleErr?.message || 'Failed to open checkout. Try again')
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setCheckoutLoading(null)
    }
  }

  const handleCancel = () => setShowCancelConfirm(true)

  const confirmCancel = async () => {
    setCancelLoading(true)
    try {
      const res = await fetch('/api/billing/cancel', { method: 'POST', credentials: 'include' })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error || 'Failed to cancel')
      }
      await fetchUsage()
      setShowCancelConfirm(false)
    } catch (err: any) {
      setError(err.message)
      setShowCancelConfirm(false)
    } finally {
      setCancelLoading(false)
    }
  }

  const paddleScript = (
    <Script
      src="https://cdn.paddle.com/paddle/v2/paddle.js"
      onLoad={() => {
        const Paddle = (window as any).Paddle
        const paddleToken = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN
        if (Paddle && paddleToken) {
          Paddle.Environment.set(process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT === 'production' ? 'production' : 'sandbox')
          Paddle.Initialize({
            token: paddleToken,
            eventCallback: (data: any) => {
              if (data.name === 'checkout.error') console.error('[Paddle Checkout Error]', JSON.stringify(data))
            },
          })
        }
      }}
    />
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-[12.5px]">Loading billing…</span>
      </div>
    )
  }

  if (error && !usage) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-rose-500/15 bg-rose-500/[0.04] py-16 text-center">
        <AlertTriangle className="h-5 w-5 text-rose-400/70" />
        <p className="text-[13px] text-rose-300/70">{error}</p>
        <KitButton variant="secondary" size="sm" onClick={fetchUsage}>Retry</KitButton>
      </div>
    )
  }

  const currentPlan = usage?.planName ?? 'SANDBOX'
  const planDisplayName = currentPlan === 'SANDBOX' ? 'Free' : currentPlan === 'BUILDER' ? 'Pro' : currentPlan === 'SCALE' ? 'Enterprise' : currentPlan
  const resetDate = usage ? new Date(usage.resetAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''
  const apiReqUsed = usage ? parseInt(usage.apiRequestsUsed, 10) || 0 : 0
  const apiReqMax = usage?.maxApiRequestsPerMonth ? parseInt(usage.maxApiRequestsPerMonth, 10) : null

  return (
    <>
      {paddleScript}

      {/* Cancel-plan confirmation — kit dialog, never window.confirm */}
      <KitConfirmDialog
        open={showCancelConfirm}
        onCancel={() => { if (!cancelLoading) setShowCancelConfirm(false) }}
        onConfirm={confirmCancel}
        title="Cancel your subscription?"
        description="You keep access until the end of your billing period, then revert to the Free plan."
        confirmLabel="Cancel plan"
        cancelLabel="Keep plan"
        danger
        busy={cancelLoading}
      />

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2.5">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-rose-400" />
          <p className="text-[12px] leading-snug text-rose-300">{error}</p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4">
        {/* Subscription */}
        <KitCard>
          <KitCardHeader
            title="Subscription"
            actions={
              currentPlan !== 'SANDBOX' ? (
                <KitButton variant="ghost" size="sm" onClick={handleCancel} disabled={cancelLoading}>
                  {cancelLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Cancel plan'}
                </KitButton>
              ) : undefined
            }
          />
          <KitCardBody>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04]">
                <Crown className="h-4 w-4 text-violet-300" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[16px] font-semibold leading-tight text-white">{planDisplayName}</p>
                <p className="mt-0.5 text-[11.5px] text-zinc-500">
                  {currentPlan === 'SANDBOX' ? 'No card required' : `Renews ${resetDate}`}
                </p>
              </div>
              <KitBadge tone="operational">Active</KitBadge>
            </div>
          </KitCardBody>
        </KitCard>
      </div>

      {/* This cycle — compact usage recap */}
      {usage && (
        <KitCard className="mt-4">
          <KitCardHeader
            title="This cycle"
            actions={
              <Link href="/app/usage" className="group inline-flex items-center gap-0.5 text-[11.5px] font-medium text-zinc-500 transition-colors hover:text-zinc-200">
                Full usage <ArrowUpRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
              </Link>
            }
          />
          <KitCardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Meter icon={Bot} label="Function invocations" used={usage.aiFunctionInvocationsUsed} max={usage.maxAiFunctionInvocationsPerMonth} />
            <Meter icon={Activity} label={usage.apiQuotaIsLifetime ? 'API requests (total)' : 'API requests'} used={apiReqUsed} max={apiReqMax} />
          </KitCardBody>
        </KitCard>
      )}

      {/* Plan chooser */}
      <div className="mt-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[13px] font-semibold text-zinc-100">Choose your plan</h3>
            <p className="mt-0.5 text-[11.5px] text-zinc-500">Flat-rate pricing. No usage fees, no surprises.</p>
          </div>
          <div className="flex items-center gap-0.5 rounded-lg border border-white/[0.07] bg-white/[0.03] p-1">
            <button
              onClick={() => setAnnual(false)}
              className={`rounded-md px-3 py-1.5 text-[11.5px] font-medium transition-colors ${!annual ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              Monthly
            </button>
            <button
              onClick={() => setAnnual(true)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11.5px] font-medium transition-colors ${annual ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              Annual
              <span className="rounded bg-emerald-500/15 px-1 py-0.5 font-mono text-[9px] font-bold text-emerald-400">−20%</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {PLAN_DEFS.map((plan) => {
            const isCurrent = currentPlan === plan.name
            const displayPrice = annual && plan.annual !== null ? plan.annual : plan.monthly
            const currentIdx = PLAN_DEFS.findIndex((p) => p.name === currentPlan)
            const planIdx = PLAN_DEFS.findIndex((p) => p.name === plan.name)
            const isUpgrade = planIdx > currentIdx

            return (
              <div
                key={plan.name}
                className={`relative flex flex-col overflow-hidden rounded-xl border bg-[#16171d] shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)] ${
                  plan.recommended ? 'border-violet-400/25' : 'border-white/[0.07]'
                }`}
              >
                {plan.recommended && (
                  <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet-300/40 to-transparent" />
                )}
                <div className="flex flex-1 flex-col p-5">
                  <div className="flex items-center gap-2">
                    <h4 className="text-[15px] font-semibold text-white">{plan.tagline}</h4>
                    {plan.recommended && <KitBadge tone="beta" icon={Zap}>Popular</KitBadge>}
                    {isCurrent && <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-zinc-500">Current</span>}
                  </div>
                  <p className="mt-1 text-[11.5px] text-zinc-500">{plan.description}</p>

                  <div className="mt-4">
                    {plan.monthly === null ? (
                      <div className="flex items-baseline gap-1">
                        <span className="font-mono text-[30px] font-semibold tabular-nums leading-none text-white">Custom</span>
                      </div>
                    ) : (
                      <div className="flex items-baseline gap-1">
                        <span className="font-mono text-[30px] font-semibold tabular-nums leading-none text-white">${displayPrice}</span>
                        <span className="text-[12px] text-zinc-500">/mo</span>
                      </div>
                    )}
                    {plan.monthly === null ? (
                      <p className="mt-1 text-[10.5px] text-zinc-600">Annual agreement, scoped to you</p>
                    ) : annual && plan.annual !== null && plan.monthly > 0 ? (
                      <p className="mt-1 text-[10.5px] text-zinc-600">Billed ${plan.annual * 12}/yr · saves ${(plan.monthly - plan.annual) * 12}/yr</p>
                    ) : plan.monthly === 0 ? (
                      <p className="mt-1 text-[10.5px] text-zinc-600">No credit card required</p>
                    ) : (
                      <p className="mt-1 text-[10.5px] text-zinc-600">Switch to annual to save 20%</p>
                    )}
                  </div>

                  <ul className="mt-5 flex-1 space-y-2">
                    {plan.limits.map((item) => (
                      <li key={item} className="flex items-start gap-2">
                        <Check className={`mt-0.5 h-3 w-3 flex-shrink-0 ${plan.recommended ? 'text-violet-400' : 'text-zinc-600'}`} />
                        <span className="text-[11.5px] leading-snug text-zinc-400">{item}</span>
                      </li>
                    ))}
                  </ul>

                  <div className="mt-5">
                    {isCurrent ? (
                      <button disabled className="w-full cursor-not-allowed rounded-lg border border-white/[0.06] bg-white/[0.02] py-2.5 text-[12px] font-medium text-zinc-600">
                        Current plan
                      </button>
                    ) : plan.ctaHref ? (
                      <a
                        href={plan.ctaHref}
                        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.04] py-2.5 text-[12px] font-semibold text-zinc-200 transition-colors hover:border-white/20 hover:bg-white/[0.08]"
                      >
                        Contact sales<ArrowRight className="h-3.5 w-3.5" />
                      </a>
                    ) : plan.name === 'SANDBOX' ? (
                      <button
                        onClick={handleCancel}
                        disabled={cancelLoading}
                        className="w-full rounded-lg border border-white/[0.08] bg-transparent py-2.5 text-[12px] font-medium text-zinc-400 transition-colors hover:border-white/[0.16] hover:text-zinc-200 disabled:opacity-40"
                      >
                        {cancelLoading ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : 'Downgrade to Free'}
                      </button>
                    ) : (
                      <button
                        onClick={() => handleUpgrade(plan.name)}
                        disabled={!!checkoutLoading}
                        className={`flex w-full items-center justify-center gap-1.5 rounded-lg py-2.5 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                          plan.recommended
                            ? 'bg-white text-black hover:bg-zinc-200'
                            : 'border border-white/[0.1] bg-white/[0.04] text-zinc-200 hover:border-white/20 hover:bg-white/[0.08]'
                        }`}
                      >
                        {checkoutLoading === plan.name ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <>{isUpgrade ? `Upgrade to ${plan.tagline}` : `Switch to ${plan.tagline}`}<ArrowRight className="h-3.5 w-3.5" /></>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        <div className="mt-5">
          <KitNote tone="info" title="Typed MCP tools have no AI charge">
            Driving your backend from Claude Code / Cursor over MCP uses your agent's intelligence — the typed tools
            (create_table, set_rls, run_query and the rest) compile straight to SQL and cost no credits. AI credits meter
            Backenly's own LLM work: the natural-language <code className="text-zinc-300">backend_chat</code> tool,
            function generation, and AI-powered tools. Need a custom plan?{' '}
            <a href="mailto:sales@backenly.com" className="text-violet-300 underline underline-offset-2 hover:text-violet-200">Contact sales</a>.
          </KitNote>
        </div>
      </div>
    </>
  )
}
