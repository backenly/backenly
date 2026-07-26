'use client'

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowRight,
  Bot,
  Database,
  KeyRound,
  Mail,
  Radio,
  RefreshCcw,
  Sparkles,
  Terminal,
  UploadCloud,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { ROUTES, SiteShell } from '@/components/site/SiteShell'

type Plan = {
  name: string
  price: string
  cadence: string
  summary: string
  bestFor: string
  cta: string
  ctaHref?: string
  highlighted?: boolean
  limits: { label: string; value: string }[]
  features: string[]
}

const plans: Plan[] = [
  {
    name: 'Free',
    price: '$0',
    cadence: 'forever',
    summary: 'Validate one real product backend without a credit card.',
    bestFor: 'First prototypes and serious experiments',
    cta: 'Start free',
    limits: [
      { label: 'Projects', value: '1 live project' },
      { label: 'Users', value: '50,000 MAU' },
      { label: 'Autonomy', value: 'Self-healing every 30 min' },
      { label: 'AI credits', value: '200 monthly' },
    ],
    features: [
      'Autonomous self-healing every 30 minutes — finds and fixes safe issues, company-funded, never your credits',
      'PostgreSQL, auth, storage, realtime, and REST APIs — the full runtime, not a trial',
      'Build over MCP with your own coding agent — the typed tools are never metered as AI',
    ],
  },
  {
    name: 'Pro',
    price: '$25',
    cadence: 'per month',
    summary: 'Production capacity, plus a backend that heals itself every minute.',
    bestFor: 'Founders with real users, agencies, and small teams',
    cta: 'Get Pro',
    highlighted: true,
    limits: [
      { label: 'Users', value: '200,000 MAU' },
      { label: 'Autonomy', value: 'Every minute, full dial' },
      { label: 'AI credits', value: '3,000 monthly' },
      { label: 'Database + storage', value: '10 GB Postgres · 100 GB files' },
    ],
    features: [
      'Self-healing every minute — effectively continuous, with the full autonomy dial. Unlimited fixes, company-funded',
      'Unlimited projects and API requests, 2M function runs, triggers, webhooks, custom domains',
      '5 team seats with org roles, full deployment history and rollback, 30-day logs',
    ],
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    cadence: 'annual agreement',
    summary: 'Run your company’s backend with custom limits, isolation, and an SLA.',
    bestFor: 'Companies replacing a backend hire or agency retainer',
    cta: 'Talk to us',
    ctaHref: `mailto:support@backenly.com?subject=Backenly%20Enterprise`,
    limits: [
      { label: 'Users', value: 'Custom MAU' },
      { label: 'Autonomy', value: 'Custom cadence' },
      { label: 'AI credits', value: 'Custom pool' },
      { label: 'Database', value: 'Dedicated capacity' },
    ],
    features: [
      'Custom autonomy cadence and guardrail policies for your compliance posture',
      'SSO (OIDC), RBAC, and priority incident response with a 12-hour SLA',
      'Onboarding and migration help, invoicing, procurement-friendly billing',
    ],
  },
]

const included: { icon: LucideIcon; label: string; body: string }[] = [
  { icon: Database, label: 'PostgreSQL', body: 'Project-scoped schemas, relations, indexes, and real data.' },
  { icon: KeyRound, label: 'Auth', body: 'JWT sessions and per-project end-user tables.' },
  { icon: UploadCloud, label: 'Storage', body: 'Buckets, uploads, metadata, and signed URLs.' },
  { icon: Radio, label: 'Realtime', body: 'SSE subscriptions, presence, and broadcast channels.' },
  { icon: Zap, label: 'Triggers', body: 'Event workflows for inserts, updates, schedules, and integrations.' },
  { icon: RefreshCcw, label: 'Rollback', body: 'Deployment history and restore paths when changes need reversing.' },
  { icon: Bot, label: 'Autonomy', body: 'Detects and fixes issues on a cadence — company-funded on every tier, never your credits.' },
  { icon: Terminal, label: 'Bring your own agent', body: 'Drive the backend from Claude Code or Cursor over MCP. Typed tools carry no AI charge — your agent, your tokens.' },
]

const comparisonRows = [
  ['Monthly active users', '50,000', '200,000', 'Custom'],
  ['Autonomy cadence', 'Every 30 minutes', 'Every minute', 'Custom'],
  ['Autonomous fixing', 'Included — company-funded', 'Included — company-funded', 'Included — company-funded'],
  ['AI credits', '200 / mo', '3,000 / mo', 'Custom pool'],
  ['Bring your own agent (MCP)', 'Typed tools: no AI charge', 'Typed tools: no AI charge', 'Typed tools: no AI charge'],
  ['Database', '512 MB Postgres', '10 GB Postgres', 'Dedicated capacity'],
  ['File storage', '1 GB', '100 GB', 'Custom'],
  ['API requests', '100k total', 'Unlimited', 'Unlimited'],
  ['Function runs', '10,000 / mo', '2M / mo', 'Custom'],
  ['Team seats', '1', '5', 'Custom'],
  ['Rollback', 'Basic restore', 'Full history', 'Custom window'],
  ['Support', 'Community', 'Email', 'Dedicated + 12h SLA'],
]

const faqs = [
  {
    q: 'Can I start without a credit card?',
    a: 'Yes. The Free plan creates one permanent live project with enough capacity to validate a real backend.',
  },
  {
    q: 'Can I self-host Backenly instead of paying?',
    a: 'Yes. The platform is open source under Apache-2.0 and free to self-host: you bring the servers, the Postgres, and the OpenAI key that powers the self-healing loop. The plans on this page are Backenly Cloud, where we run the infrastructure, handle backups and upgrades, and fund the autonomy tokens on every tier. It is the same codebase either way, and pg_dump moves your data between the two.',
  },
  {
    q: 'What counts as an AI credit?',
    a: 'One credit is 1,000 tokens of Backenly’s own model usage. Credits are spent when Backenly does the thinking: its chat, the natural-language MCP tool (backend_chat), and LLM-powered tools like the architect and function generation. They are a small included line, not the headline — the typed MCP tools cost nothing, and autonomy is company-funded on every tier.',
  },
  {
    q: 'Does driving the backend from my coding agent cost credits?',
    a: 'Almost never — it depends which tool your agent calls. The typed MCP tools (create_table, add_column, set_rls, generate_types, run_query and the rest) compile straight to SQL with no model call, so they are free on every plan: your agent supplies the intelligence and you pay your own provider. The exception is the natural-language tools — backend_chat and generate_function — where Backenly runs its own model on your behalf, and those draw credits. Point your agent at the typed tools and the AI meter stays at zero.',
  },
  {
    q: 'Does autonomy spend my credits?',
    a: 'Never. Autonomous self-healing is included on every tier — every 30 minutes on Free, every minute on Pro, custom cadence on Enterprise — and it is company-funded. Your credits are for asking; keeping the backend alive is on us. Pro raises the cadence and volume, not the capability.',
  },
  {
    q: 'Are database, auth, storage, and realtime paid add-ons?',
    a: 'No. Core backend primitives are included on every plan. Paid tiers increase capacity, support, rollback windows, and advanced controls.',
  },
  {
    q: 'Am I locked in? Can I get my data out?',
    a: 'Your backend is standard PostgreSQL, and it stays yours. Every plan — including Free — gets a real read-only connection string (psql, TablePlus, any BI tool), an optional read-write one, and one-click pg_dump exports that restore on any Postgres: RDS, Neon, your own server. The platform is open source too, so a full self-hosted Backenly is always an exit path. Schema, data, constraints, indexes — everything leaves with you, anytime, with no exit fee.',
  },
  {
    q: 'Can I cancel anytime?',
    a: 'Yes. Paid access continues until the end of the billing period, then the account returns to the Free plan.',
  },
  {
    q: 'What does the Enterprise plan include?',
    a: 'Custom user, credit, and storage limits, dedicated project isolation, onboarding and migration help, priority incident response with an SLA, and invoicing. Email support@backenly.com with what you are running and we will scope it around your product.',
  },
]

export default function PricingPage() {
  const router = useRouter()
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadSession() {
      try {
        const token = localStorage.getItem('auth-token')
        if (!token) {
          if (!cancelled) setIsLoggedIn(false)
          return
        }

        const response = await fetch('/api/auth/me', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (cancelled) return

        setIsLoggedIn(response.ok)
        if (response.ok) {
          const projectId = localStorage.getItem('current-project-id')
          if (projectId) setCurrentProjectId(projectId)
        }
      } catch {
        if (!cancelled) setIsLoggedIn(false)
      }
    }

    void loadSession()

    return () => {
      cancelled = true
    }
  }, [])

  function handleCta() {
    if (!isLoggedIn) {
      router.push(ROUTES.signup)
      return
    }

    if (currentProjectId) {
      router.push('/app/settings?tab=billing')
      return
    }

    router.push('/app/settings?tab=billing')
  }

  return (
    <SiteShell>
      <main className="relative z-20">
        <section className="px-6 pt-12 pb-16 md:pt-20 md:pb-20">
          <div className="mx-auto max-w-7xl">
            <div className="max-w-3xl">
              <p className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.035] px-3 py-1.5 text-xs font-semibold uppercase text-zinc-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                Pricing
              </p>
              <h1 className="mt-6 max-w-3xl text-4xl font-semibold leading-[1.04] text-white md:text-5xl">
                Start free, then scale the backend when usage proves it.
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-7 text-zinc-400 md:text-[17px]">
                Every plan includes the real Backenly runtime: PostgreSQL, generated REST APIs,
                auth, storage, realtime, monitoring, and restore points — plus a self-healing
                loop that never touches your credits. Prefer to run it yourself? Backenly is
                open source under Apache-2.0 and free to self-host.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <ActionButton onClick={handleCta} variant="primary">
                  Start free
                  <ArrowRight className="h-4 w-4" />
                </ActionButton>
                <a
                  href={`mailto:${ROUTES.supportEmail}?subject=Backenly%20pricing%20question`}
                  className="inline-flex h-12 items-center justify-center rounded-md border border-white/12 bg-white/[0.03] px-5 text-sm font-semibold text-white transition hover:border-white/25 hover:bg-white/[0.06]"
                >
                  <Mail className="mr-2 h-4 w-4" />
                  Contact support
                </a>
              </div>
            </div>

            <div className="mt-12 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
              {plans.map((plan) => (
                <PlanCard key={plan.name} plan={plan} onCta={handleCta} />
              ))}
            </div>

            {/* Portability guarantee — stated where buying decisions happen, not
                buried in the FAQ. Flat by design (locked pricing-page language). */}
            <div className="mt-6 rounded-lg border border-white/10 bg-white/[0.03] px-5 py-4">
              <p className="text-sm leading-6 text-zinc-400">
                <span className="font-semibold text-zinc-200">No lock-in, on every plan:</span>{' '}
                your backend is standard PostgreSQL with a real connection string — connect psql or any
                BI tool, and export a full <span className="font-mono text-[13px]">pg_dump</span> backup
                that restores on any Postgres. And the platform itself is open source (Apache-2.0), so the
                exit path includes running Backenly on your own servers. Your data leaves with you,
                anytime, free plan included.
              </p>
            </div>
          </div>
        </section>

        <section className="border-t border-white/[0.06] px-6 py-16 md:py-20">
          <div className="mx-auto max-w-7xl">
            <div className="grid gap-10 lg:grid-cols-[360px_minmax(0,1fr)] lg:items-start">
              <div>
                <p className="text-sm font-semibold text-zinc-500">Included runtime</p>
                <h2 className="mt-3 text-3xl font-semibold leading-tight text-white md:text-4xl">
                  The backend foundation is not split into add-ons.
                </h2>
                <p className="mt-5 text-base leading-7 text-zinc-400">
                  Paid plans increase capacity and support. The primitives you need to build a
                  real backend are available from the first project.
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {included.map((item) => {
                  const Icon = item.icon
                  return (
                    <div
                      key={item.label}
                      className="flex gap-4 rounded-lg border border-white/10 bg-white/[0.035] p-5"
                    >
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-white/10 bg-black/35">
                        <Icon className="h-5 w-5 text-zinc-200" strokeWidth={1.75} />
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-white">{item.label}</h3>
                        <p className="mt-1 text-sm leading-6 text-zinc-400">{item.body}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </section>

        <section className="border-t border-white/[0.06] px-6 py-16 md:py-20">
          <div className="mx-auto max-w-6xl">
            <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
              <div>
                <p className="text-sm font-semibold text-zinc-500">Compare plans</p>
                <h2 className="mt-3 text-3xl font-semibold text-white">Capacity changes. Core runtime stays.</h2>
              </div>
              <p className="max-w-xl text-sm leading-6 text-zinc-500">
                Running at company scale? Enterprise adds custom limits, dedicated isolation,
                onboarding help, and an SLA — email support and we will scope it with you.
              </p>
            </div>

            <div className="mt-8 grid gap-3 md:hidden">
              {comparisonRows.map(([label, free, pro, enterprise]) => (
                <div key={label} className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
                  <h3 className="text-sm font-semibold text-white">{label}</h3>
                  <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
                    <div>
                      <p className="text-xs text-zinc-600">Free</p>
                      <p className="mt-1 font-medium text-zinc-300">{free}</p>
                    </div>
                    <div>
                      <p className="text-xs text-zinc-600">Pro</p>
                      <p className="mt-1 font-medium text-zinc-300">{pro}</p>
                    </div>
                    <div>
                      <p className="text-xs text-zinc-600">Enterprise</p>
                      <p className="mt-1 font-medium text-zinc-300">{enterprise}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-8 hidden overflow-hidden rounded-lg border border-white/10 bg-white/[0.03] md:block">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-zinc-500">
                    <th className="px-5 py-4 font-medium">Limit</th>
                    <th className="px-5 py-4 font-medium">Free</th>
                    <th className="px-5 py-4 font-medium">Pro</th>
                    <th className="px-5 py-4 font-medium">Enterprise</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {comparisonRows.map(([label, free, pro, enterprise]) => (
                    <tr key={label}>
                      <td className="px-5 py-4 font-medium text-zinc-200">{label}</td>
                      <td className="px-5 py-4 text-zinc-400">{free}</td>
                      <td className="px-5 py-4 text-zinc-400">{pro}</td>
                      <td className="px-5 py-4 text-zinc-400">{enterprise}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="border-t border-white/[0.06] px-6 py-16 md:py-20">
          <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[360px_minmax(0,1fr)]">
            <div>
              <p className="text-sm font-semibold text-zinc-500">FAQ</p>
              <h2 className="mt-3 text-3xl font-semibold text-white">Straight answers before you choose.</h2>
            </div>
            <div className="divide-y divide-white/10 rounded-lg border border-white/10 bg-white/[0.03]">
              {faqs.map((item) => (
                <div key={item.q} className="p-6">
                  <h3 className="text-sm font-semibold text-white">{item.q}</h3>
                  <p className="mt-3 text-sm leading-6 text-zinc-400">{item.a}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-white/[0.06] px-6 py-16 md:py-24">
          <div className="mx-auto max-w-4xl rounded-lg border border-white/10 bg-white/[0.04] p-8 text-center md:p-12">
            <Sparkles className="mx-auto h-6 w-6 text-zinc-300" strokeWidth={1.75} />
            <h2 className="mt-5 text-3xl font-semibold text-white md:text-4xl">
              Build the first backend for free.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-sm leading-6 text-zinc-400">
              No credit card. One live project. Upgrade only when your product needs more capacity.
            </p>
            <ActionButton onClick={handleCta} variant="primary" className="mt-7">
              Start free
              <ArrowRight className="h-4 w-4" />
            </ActionButton>
          </div>
        </section>
      </main>
    </SiteShell>
  )
}

function PlanCard({ plan, onCta }: { plan: Plan; onCta: () => void }) {
  return (
    <article
      className={`relative flex h-full flex-col rounded-lg border p-6 ${
        plan.highlighted
          ? 'border-white/25 bg-white/[0.07] shadow-[0_34px_110px_-80px_rgba(255,255,255,0.65)]'
          : 'border-white/10 bg-white/[0.035]'
      }`}
    >
      {plan.highlighted && (
        <span className="absolute right-5 top-5 rounded-md border border-emerald-300/25 bg-emerald-400/10 px-2.5 py-1 text-xs font-semibold text-emerald-200">
          Most popular
        </span>
      )}

      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{plan.name}</p>
      <div className="mt-5 flex items-end gap-2">
        <span className="text-5xl font-semibold tracking-tight text-white">{plan.price}</span>
        <span className="pb-1 text-sm text-zinc-500">{plan.cadence}</span>
      </div>
      <p className="mt-4 min-h-[52px] text-sm leading-6 text-zinc-400">{plan.summary}</p>

      <div className="mt-6 border-y border-white/10">
        {plan.limits.map((limit) => (
          <div key={limit.label} className="flex items-center justify-between gap-4 border-b border-white/10 py-3 last:border-b-0">
            <span className="text-sm text-zinc-500">{limit.label}</span>
            <span className="text-right text-sm font-medium text-zinc-200">{limit.value}</span>
          </div>
        ))}
      </div>

      {plan.ctaHref ? (
        <a
          href={plan.ctaHref}
          className="mt-6 inline-flex h-12 w-full items-center justify-center gap-2 rounded-md border border-white/12 bg-white/[0.03] px-5 text-sm font-semibold text-white transition hover:border-white/25 hover:bg-white/[0.06]"
        >
          {plan.cta}
        </a>
      ) : (
        <ActionButton onClick={onCta} variant={plan.highlighted ? 'primary' : 'secondary'} className="mt-6 w-full">
          {plan.cta}
        </ActionButton>
      )}

      <div className="mt-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Best for</p>
        <p className="mt-2 text-sm text-zinc-300">{plan.bestFor}</p>
      </div>

      <ul className="mt-6 space-y-3">
        {plan.features.map((feature) => (
          <li key={feature} className="flex gap-3 text-sm leading-6 text-zinc-400">
            <span aria-hidden className="mt-2.5 h-1 w-1 shrink-0 rounded-full bg-zinc-600" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
    </article>
  )
}

function ActionButton({
  onClick,
  variant,
  className = '',
  children,
}: {
  onClick: () => void
  variant: 'primary' | 'secondary'
  className?: string
  children: ReactNode
}) {
  const style =
    variant === 'primary'
      ? 'bg-white text-black hover:bg-zinc-200'
      : 'border border-white/12 bg-white/[0.03] text-white hover:border-white/25 hover:bg-white/[0.06]'

  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-12 items-center justify-center gap-2 rounded-md px-5 text-sm font-semibold transition ${style} ${className}`}
    >
      {children}
    </button>
  )
}
