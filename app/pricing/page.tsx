'use client'

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowRight,
  Bot,
  Check,
  Database,
  KeyRound,
  Layers,
  LifeBuoy,
  Mail,
  Minus,
  Radio,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Terminal,
  UploadCloud,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { ROUTES, SiteShell } from '@/components/site/SiteShell'
import { useUserSession } from '@/lib/hooks/useUserSession'
import {
  includedEgressMb,
  PRO_INCLUDED,
  proUsagePriceRows,
  usagePricingPublished,
  type OverageAxis,
} from '@/lib/pricing/catalog'

type Plan = {
  name: string
  price: string
  cadence: string
  /** The annual price, where the plan has one. */
  annual?: string
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
      { label: 'Autonomy', value: 'Self-healing every minute' },
      { label: 'AI credits', value: '200 monthly' },
    ],
    features: [
      'Self-healing every minute, repairing everything it safely can: never capped, never metered',
      'PostgreSQL, auth, storage, realtime, and REST APIs: the full runtime, not a trial',
      'Build over MCP with your own coding agent: the typed tools are never metered as AI',
    ],
  },
  {
    name: 'Pro',
    price: '$25',
    cadence: 'per month',
    annual: '$240 billed yearly: $20 a month',
    summary: 'Production capacity, plus a backend that heals itself every minute.',
    bestFor: 'Founders with real users, agencies, and small teams',
    cta: 'Get Pro',
    highlighted: true,
    limits: [
      { label: 'Users', value: `${PRO_INCLUDED.mau.toLocaleString('en-US')} MAU` },
      { label: 'Autonomy', value: 'Every minute, full dial' },
      { label: 'AI credits', value: '3,000 monthly' },
      { label: 'Database + storage', value: `${PRO_INCLUDED.dbGib} GB Postgres · ${PRO_INCLUDED.fileGib} GB files` },
    ],
    features: [
      'The same uncapped self-healing loop as Free: you pay for capacity, never for uptime',
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
      { label: 'Autonomy', value: 'Every minute, full dial' },
      { label: 'AI credits', value: 'Custom pool' },
      { label: 'Database', value: 'Custom capacity' },
    ],
    features: [
      'Custom guardrail policies for your compliance posture',
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
  { icon: Zap, label: 'Triggers', body: 'Event workflows for inserts, updates, schedules, and integrations. On Pro and Enterprise.' },
  { icon: RefreshCcw, label: 'Rollback', body: 'Deployment history and restore paths when changes need reversing.' },
  { icon: Bot, label: 'Autonomy', body: 'Watches your live backend every minute and repairs what is safe to repair. Included on every plan.' },
  { icon: Terminal, label: 'Bring your own agent', body: 'Drive the backend from Claude Code or Cursor over MCP. Typed tools carry no AI charge: your agent, your tokens.' },
]

/**
 * One cell of the comparison: a value, a yes/no, or an included amount with the
 * rate past it underneath ("100,000 included / then $0.003 per MAU").
 */
type Cell = string | boolean | { value: string; then?: string | null }
type MatrixRow = { label: string; hint?: string; cells: readonly [Cell, Cell, Cell] }
type MatrixGroup = { icon: LucideIcon; title: string; rows: MatrixRow[] }

/**
 * The plan comparison. Free and Enterprise state the Plan rows the product
 * enforces (Cloud overlay prisma/seed-billing.ts). Pro's metered quantities and
 * their rates come from lib/pricing/catalog.ts, the catalog that also prices the
 * usage, so the page cannot state a rate the product does not charge. A rate
 * appears only in a build that publishes usage pricing, and only once the
 * catalog publishes that axis's rate (database waits on its measured cost).
 */
function comparisonGroups(published: boolean): MatrixGroup[] {
  const pro = new Map(proUsagePriceRows().map((r) => [r.axis, r]))
  const metered = (axis: OverageAxis): Cell => {
    const row = pro.get(axis)!
    return { value: `${row.included} included`, then: published && row.rate ? `then ${row.rate}` : null }
  }
  const groups: MatrixGroup[] = [
    {
      icon: Layers,
      title: 'Plan',
      rows: [
        { label: 'Price', cells: ['$0 forever', { value: '$25 per month', then: 'or $240 per year' }, 'Annual agreement'] },
        { label: 'Projects', cells: ['1', 'Unlimited', 'Unlimited'] },
        { label: 'Team seats', cells: ['1', '5, with org roles', 'Custom'] },
      ],
    },
    {
      icon: Database,
      title: 'Database',
      rows: [
        { label: 'Postgres database', hint: 'Shared by every project on your account', cells: ['512 MB', metered('db_bytes'), 'Custom'] },
        { label: 'API requests', hint: 'No per-request fee on any plan', cells: ['100,000 total', 'Unlimited', 'Unlimited'] },
        { label: 'Daily backups', cells: ['7 days kept', '7 days kept', '7 days kept'] },
        { label: 'Direct Postgres access and pg_dump export', cells: [true, true, true] },
        { label: 'Deployment history and rollback', cells: [false, 'Full history', 'Full history'] },
      ],
    },
    {
      icon: KeyRound,
      title: 'Auth',
      rows: [
        { label: 'Monthly active users', cells: ['50,000', metered('mau'), 'Custom'] },
        { label: 'Email, password and social sign-in', cells: [true, true, true] },
      ],
    },
    {
      icon: UploadCloud,
      title: 'Storage',
      rows: [
        { label: 'File storage', cells: ['1 GB', metered('file_bytes'), 'Custom'] },
        { label: 'Egress', cells: ['5 GB', metered('egress_bytes'), 'Custom'] },
      ],
    },
    {
      icon: Radio,
      title: 'Realtime',
      rows: [
        { label: 'Concurrent connections', cells: ['25', '1,000', 'Custom'] },
        { label: 'Database changes, presence and broadcast', cells: [true, true, true] },
      ],
    },
    {
      icon: Zap,
      title: 'Functions and events',
      rows: [
        { label: 'Function runs', cells: ['10,000 per month', metered('fn_runs'), 'Custom'] },
        { label: 'Event triggers', cells: [false, 'Unlimited', 'Unlimited'] },
        { label: 'Outbound webhooks', cells: [false, true, true] },
        { label: 'Custom domains', cells: [false, true, true] },
      ],
    },
    {
      icon: Bot,
      title: 'AI and agents',
      rows: [
        {
          label: 'AI credits',
          hint: 'One credit is 1,000 tokens of Backenly’s own model usage',
          cells: ['200 per month', '3,000 per month', 'Custom pool'],
        },
        { label: 'Build over MCP with your own agent', hint: 'Typed tools never draw credits', cells: ['No charge', 'No charge', 'No charge'] },
        { label: 'Autonomous healing', hint: 'Checks every minute, repairs what is safe', cells: ['Never metered', 'Never metered', 'Never metered'] },
      ],
    },
  ]
  if (published) {
    groups.push({
      icon: ShieldCheck,
      title: 'Billing protection',
      rows: [
        {
          label: 'Usage past the included amounts',
          cells: ['Hard caps, never billed', { value: 'Only up to your spend limit', then: 'Off by default: every quota is a hard cap' }, 'Per contract'],
        },
        {
          label: 'Spend limit',
          hint: 'Only an owner can raise it; agents and API keys can only read it',
          cells: [false, { value: '$50, $100, $250 or your own', then: 'Emails at 50%, 80% and 100%' }, 'Per contract'],
        },
      ],
    })
  }
  groups.push({
    icon: LifeBuoy,
    title: 'Platform and support',
    rows: [
      { label: 'Log retention', cells: ['7 days', '30 days', '90 days'] },
      { label: 'Single sign-on (OIDC)', cells: [false, false, true] },
      { label: 'Support', cells: ['Community', 'Email', 'Dedicated, 12-hour SLA'] },
    ],
  })
  return groups
}

/** What $25 buys, stated as the whole package rather than one unit rate. */
const proPackage = [
  `${PRO_INCLUDED.mau.toLocaleString('en-US')} MAU`,
  `${PRO_INCLUDED.dbGib} GB database`,
  `${PRO_INCLUDED.fileGib} GB files`,
  `${(includedEgressMb('BUILDER', 'cdn') ?? 0) / 1024} GB egress`,
  `${PRO_INCLUDED.fnRuns / 1_000_000}M function runs`,
  '3,000 AI credits',
  'Unlimited projects',
  'No extra charge for MCP',
  'No extra charge for autonomous healing',
  'No API-request fee',
]

const faqs = [
  {
    q: 'Can I start without a credit card?',
    a: 'Yes. The Free plan creates one permanent live project with enough capacity to validate a real backend.',
  },
  {
    q: 'Can I self-host Backenly instead of paying?',
    a: 'Yes. The platform is open source under Apache-2.0 and free to self-host: you bring the servers, the Postgres, and an OpenAI key if you want the natural-language build tools (the self-healing loop itself needs no model). The plans on this page are Backenly Cloud, where we run the infrastructure and handle backups and upgrades. It is the same codebase either way, and pg_dump moves your data between the two.',
  },
  {
    q: 'What counts as an AI credit?',
    a: 'One credit is 1,000 tokens of Backenly’s own model usage. Credits are spent when Backenly runs its own model on your behalf: the natural-language MCP tool (backend_chat), including the LLM-powered steps inside that turn such as the architect and function generation. They are a small included line, not the headline: the dashboard assistant answers questions free, the typed MCP tools cost nothing, and autonomy never draws credits.',
  },
  {
    q: 'Does driving the backend from my coding agent cost credits?',
    a: 'Almost never, it depends which tool your agent calls. The typed MCP tools (create_table, add_column, set_rls, generate_types, run_query and the rest) compile straight to SQL with no model call, so they are free on every plan: your agent supplies the intelligence and you pay your own provider. The exception is the natural-language tools: backend_chat and generate_function: where Backenly runs its own model on your behalf, and those draw credits: you are billed the tokens the call actually burned, nothing more. Point your agent at the typed tools and the AI meter stays at zero.',
  },
  {
    q: 'Does autonomy spend my credits?',
    a: 'Never. Detection and repair are deterministic: probes find drift, and each finding maps to a typed repair that compiles to SQL: no model in the repair path, so there is nothing to bill you for. When the loop cannot fix something and escalates it to you, a model may write up the diagnosis you read; that pass is on us, never your credits. Every plan gets the identical loop: checks every minute, repairs everything it safely can, with no per-window cap and no monthly limit, Free included. We do not meter healing: a backend that stops repairing itself once you hit a quota is the exact failure we built this to remove. Plans differ on capacity: projects, users, storage, AI credits, never on whether your backend is allowed to stay healthy.',
  },
  {
    q: 'Are database, auth, storage, and realtime paid add-ons?',
    a: 'No. Core backend primitives are included on every plan. Paid tiers increase capacity, support, rollback windows, and advanced controls.',
  },
  {
    q: 'Am I locked in? Can I get my data out?',
    a: 'Your backend is standard PostgreSQL, and it stays yours. Every plan: including Free: gets a real read-only connection string (psql, TablePlus, any BI tool), an optional read-write one, and one-click pg_dump exports that restore on any Postgres: RDS, Neon, your own server. The platform is open source too, so a full self-hosted Backenly is always an exit path. Schema, data, constraints, indexes: everything leaves with you, anytime, with no exit fee.',
  },
  {
    q: 'Can I cancel anytime?',
    a: 'Yes. Paid access continues until the end of the billing period, then the account returns to the Free plan.',
  },
]

/** Shown only in a build that publishes usage pricing. */
const usageFaq = {
  q: 'What happens when I go past what Pro includes?',
  a: 'Nothing is billed unless you choose it. Pro’s quotas are shared by every project on your account, and your spend limit is off by default, so each quota is a hard cap. Set a limit ($50, $100, $250 or your own) and usage continues at the rates in the table, never past that limit, with emails at 50%, 80% and 100%. Usage is billed monthly, amounts under $5 roll into the next month, and projects, API requests, autonomy, the typed MCP tools, deploys and rollbacks are never billed at all.',
}

export default function PricingPage() {
  const router = useRouter()
  const { isLoggedIn } = useUserSession()
  const published = usagePricingPublished()

  function handleCta() {
    if (!isLoggedIn) {
      router.push(ROUTES.signup)
      return
    }

    // Billing was promoted out of settings into its own org page. The legacy
    // `?tab=billing` deep link still works, but only because settings/page.tsx
    // catches it and redirects — so sending people through it costs a needless
    // client-side bounce. Go straight to the real page.
    router.push('/app/billing')
  }

  return (
    <SiteShell>
      <main className="relative z-20">
        <section className="px-6 pt-12 pb-16 md:pt-20 md:pb-20">
          <div className="mx-auto max-w-7xl 2xl:max-w-[100rem]">
            <div className="max-w-3xl">
              {/* Matches kit's <Eyebrow>: no status dot. A green dot here put
                  a second accent colour on the page, and the neutral-first
                  palette keeps violet as the only one. */}
              <p className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.035] px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-400">
                Pricing
              </p>
              <h1 className="mt-6 max-w-3xl text-4xl font-semibold leading-[1.04] text-white md:text-5xl">
                Start free, then scale the backend when usage proves it.
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-7 text-zinc-400 md:text-[17px]">
                Every plan includes the real Backenly runtime: PostgreSQL, generated REST APIs,
                auth, storage, realtime, monitoring, and restore points, plus a self-healing
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

            {/* 1 -> 3, never 2 + 1. At md:grid-cols-2 a three-tier table put Free and
                Pro side by side and orphaned Enterprise on a second row at half
                width, across 768-1279px (12" tablet portrait included). Three
                columns at lg gives each card ~312px there, the same width it
                has on a 1440px desktop. */}
            <div className="mt-12 grid gap-5 lg:grid-cols-3">
              {plans.map((plan) => (
                <PlanCard key={plan.name} plan={plan} onCta={handleCta} />
              ))}
            </div>

            {/* The whole Pro package in one line of chips: the value is the
                bundle, not any single unit rate. */}
            <div className="mt-6 rounded-lg border border-white/10 bg-white/[0.03] px-5 py-4">
              <p className="text-sm font-semibold text-zinc-200">Everything in Pro, for $25 a month</p>
              <ul className="mt-3 flex flex-wrap gap-2">
                {proPackage.map((item) => (
                  <li key={item} className="rounded-md border border-white/10 bg-black/30 px-2.5 py-1 text-xs text-zinc-300">
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            {/* Portability guarantee: stated where buying decisions happen, not
                buried in the FAQ. Flat by design (locked pricing-page language). */}
            <div className="mt-6 rounded-lg border border-white/10 bg-white/[0.03] px-5 py-4">
              <p className="text-sm leading-6 text-zinc-400">
                <span className="font-semibold text-zinc-200">No lock-in, on every plan:</span>{' '}
                your backend is standard PostgreSQL with a real connection string, connect psql or any
                BI tool, and export a full <span className="font-mono text-[13px]">pg_dump</span> backup
                that restores on any Postgres. And the platform itself is open source (Apache-2.0), so the
                exit path includes running Backenly on your own servers. Your data leaves with you,
                anytime, free plan included.
              </p>
            </div>
          </div>
        </section>

        <section className="border-t border-white/[0.06] px-6 py-16 md:py-20">
          <div className="mx-auto max-w-7xl 2xl:max-w-[100rem]">
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

        <ComparisonSection published={published} onCta={handleCta} />

        <section className="border-t border-white/[0.06] px-6 py-16 md:py-20">
          <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[360px_minmax(0,1fr)]">
            <div>
              <p className="text-sm font-semibold text-zinc-500">FAQ</p>
              <h2 className="mt-3 text-3xl font-semibold text-white">Straight answers before you choose.</h2>
            </div>
            <div className="divide-y divide-white/10 rounded-lg border border-white/10 bg-white/[0.03]">
              {[...faqs, ...(published ? [usageFaq] : [])].map((item) => (
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
        <span className="absolute right-5 top-5 rounded-md border border-violet-400/25 bg-violet-500/[0.12] px-2.5 py-1 text-xs font-semibold text-violet-200">
          Most popular
        </span>
      )}

      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{plan.name}</p>
      <div className="mt-5 flex items-end gap-2">
        <span className="text-5xl font-semibold tracking-tight text-white">{plan.price}</span>
        <span className="pb-1 text-sm text-zinc-500">{plan.cadence}</span>
      </div>
      {plan.annual && <p className="mt-2 text-xs text-zinc-500">{plan.annual}</p>}
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

/**
 * The plan comparison, grouped the way people compare backends: each row states
 * what a plan includes and, for Pro's metered quantities, the rate past it.
 * On small screens every row becomes a card with the three plans side by side.
 */
function ComparisonSection({ published, onCta }: { published: boolean; onCta: () => void }) {
  const groups = comparisonGroups(published)
  const heads = [
    { name: 'Free', price: '$0', cadence: 'forever', cta: 'Start free' },
    { name: 'Pro', price: '$25', cadence: 'per month', cta: 'Get Pro' },
    { name: 'Enterprise', price: 'Custom', cadence: 'annual', cta: 'Talk to us' },
  ]
  return (
    <section className="border-t border-white/[0.06] px-6 py-16 md:py-20">
      <div className="mx-auto max-w-6xl 2xl:max-w-7xl">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div>
            <p className="text-sm font-semibold text-zinc-500">Compare plans</p>
            <h2 className="mt-3 text-3xl font-semibold text-white">Capacity changes. Core runtime stays.</h2>
          </div>
          <p className="max-w-xl text-sm leading-6 text-zinc-500">
            {published
              ? 'Pro’s quotas are shared by every project on your account. Past them, nothing is billed unless you set a spend limit; with one, usage continues at the rates shown, never past it.'
              : 'Running at company scale? Enterprise adds custom limits, SSO, onboarding and migration help, and a 12-hour SLA.'}
          </p>
        </div>

        <div className="mt-8 space-y-8 md:hidden">
          {groups.map((group) => (
            <div key={group.title}>
              <GroupTitle group={group} />
              <div className="mt-3 grid gap-3">
                {group.rows.map((row) => (
                  <div key={row.label} className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
                    <h3 className="text-sm font-semibold text-white">{row.label}</h3>
                    {row.hint && <p className="mt-1 text-xs text-zinc-500">{row.hint}</p>}
                    <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
                      {row.cells.map((cell, i) => (
                        <div key={heads[i].name}>
                          <p className="text-xs text-zinc-600">{heads[i].name}</p>
                          <div className="mt-1">
                            <CellView cell={cell} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-8 hidden rounded-lg border border-white/10 bg-white/[0.02] md:block">
          <table className="w-full table-fixed text-left text-sm">
            <colgroup>
              <col className="w-[31%]" />
              <col />
              <col className="bg-white/[0.025]" />
              <col />
            </colgroup>
            <thead>
              <tr className="border-b border-white/10">
                <th className="px-5 py-5"><span className="sr-only">Feature</span></th>
                {heads.map((head) => (
                  <th key={head.name} className="px-5 py-5 align-top font-normal">
                    <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{head.name}</p>
                    <p className="mt-1">
                      <span className="text-xl font-semibold text-white">{head.price}</span>
                      <span className="ml-1.5 text-xs text-zinc-500">{head.cadence}</span>
                    </p>
                    {head.name === 'Enterprise' ? (
                      <a
                        href="mailto:support@backenly.com?subject=Backenly%20Enterprise"
                        className="mt-3 inline-flex h-9 w-full items-center justify-center rounded-md border border-white/12 bg-white/[0.03] text-xs font-semibold text-white transition hover:border-white/25 hover:bg-white/[0.06]"
                      >
                        {head.cta}
                      </a>
                    ) : (
                      <button
                        type="button"
                        onClick={onCta}
                        className={`mt-3 inline-flex h-9 w-full items-center justify-center rounded-md text-xs font-semibold transition ${
                          head.name === 'Pro'
                            ? 'bg-white text-black hover:bg-zinc-200'
                            : 'border border-white/12 bg-white/[0.03] text-white hover:border-white/25 hover:bg-white/[0.06]'
                        }`}
                      >
                        {head.cta}
                      </button>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.title} className="border-b border-white/10 last:border-b-0">
                <tr>
                  <th colSpan={4} scope="colgroup" className="px-5 pb-3 pt-7 text-left font-normal">
                    <GroupTitle group={group} />
                  </th>
                </tr>
                {group.rows.map((row) => (
                  <tr key={row.label} className="border-t border-white/[0.06]">
                    <th scope="row" className="px-5 py-4 align-top font-normal">
                      <p className="font-medium text-zinc-200">{row.label}</p>
                      {row.hint && <p className="mt-1 text-xs leading-5 text-zinc-500">{row.hint}</p>}
                    </th>
                    {row.cells.map((cell, i) => (
                      <td key={heads[i].name} className="px-5 py-4 align-top">
                        <CellView cell={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      </div>
    </section>
  )
}

function GroupTitle({ group }: { group: MatrixGroup }) {
  const Icon = group.icon
  return (
    <span className="inline-flex items-center gap-3">
      <span className="flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-black/35">
        <Icon className="h-4 w-4 text-zinc-200" strokeWidth={1.75} />
      </span>
      <span className="text-base font-semibold text-white">{group.title}</span>
    </span>
  )
}

function CellView({ cell }: { cell: Cell }) {
  if (cell === true) {
    return (
      <span className="inline-flex">
        <Check aria-hidden className="h-4 w-4 text-zinc-200" strokeWidth={2} />
        <span className="sr-only">Included</span>
      </span>
    )
  }
  if (cell === false) {
    return (
      <span className="inline-flex">
        <Minus aria-hidden className="h-4 w-4 text-zinc-600" strokeWidth={2} />
        <span className="sr-only">Not included</span>
      </span>
    )
  }
  if (typeof cell === 'string') return <p className="text-zinc-300">{cell}</p>
  return (
    <div>
      <p className="text-zinc-200">{cell.value}</p>
      {cell.then && <p className="mt-1 text-xs leading-5 text-zinc-500">{cell.then}</p>}
    </div>
  )
}
