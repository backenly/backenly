'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowRight,
  Bot,
  Check,
  Database,
  KeyRound,
  Layers,
  LifeBuoy,
  Minus,
  Radio,
  RefreshCcw,
  ShieldCheck,
  Terminal,
  UploadCloud,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { ROUTES, SiteShell } from '@/components/site/SiteShell'
import { HorizonClose, Page, PageHero, Section, SectionHead } from '@/components/site/kit'
import { Faq } from '@/components/site/Faq'
import { Reveal } from '@/components/site/Reveal'
import { StartButton } from '@/components/site/StartButton'
import { HEADING, INK, PANEL, PRIMARY_CTA, SECONDARY_CTA, TITLE } from '@/components/site/tokens'
import { useUserSession } from '@/lib/hooks/useUserSession'
import {
  PRO_INCLUDED,
  proUsagePriceRows,
  usagePricingPublished,
  type OverageAxis,
} from '@/lib/pricing/catalog'

/* ─────────────────────────────────────────────────────────────
   /pricing, rebuilt 2026-09-30 on the landing page's system.

   Unchanged on purpose: every number, every plan row, the catalog-driven
   rates (a rate only appears once lib/pricing/catalog.ts publishes it), the
   startup offer above the plan cards and its single action (founder
   decisions, see #178), the portability line, and the FAQ text.

   What moved: the plans stand on the lit stage under the hero; Pro carries the
   page's one light instead of a "Most popular" badge nobody can verify; a
   monthly / yearly switch shows the real annual price; the comparison table's
   plan header sticks under the navbar so a long table never loses its columns.
───────────────────────────────────────────────────────────── */

type Cadence = 'monthly' | 'yearly'

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
      { label: 'Autonomy', value: 'Self-healing every minute' },
      { label: 'AI credits', value: '200 monthly' },
    ],
    features: [
      'Self-healing every minute, repairing everything it safely can, never capped and never metered',
      'PostgreSQL, auth, storage, realtime and REST APIs with unlimited API requests: the full runtime, not a trial',
      'Build over MCP with your own coding agent; the typed tools are never metered as AI',
    ],
  },
  {
    name: 'Pro',
    price: '$25',
    cadence: 'per month',
    summary: 'Production capacity, plus a backend that heals itself every minute.',
    bestFor: 'Founders with real users, agencies and small teams',
    cta: 'Get Pro',
    highlighted: true,
    limits: [
      { label: 'Users', value: `${PRO_INCLUDED.mau.toLocaleString('en-US')} MAU` },
      { label: 'Autonomy', value: 'Every minute, full dial' },
      { label: 'AI credits', value: '3,000 monthly' },
      { label: 'Database and files', value: `${PRO_INCLUDED.dbGib}\u00a0GB Postgres, ${PRO_INCLUDED.fileGib}\u00a0GB files` },
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
    summary: 'Run your company’s backend with custom limits, isolation and an SLA.',
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

/** Pro billed yearly: $240 a year, which is $20 a month. */
const PRO_YEARLY_TOTAL = '$240'
const PRO_YEARLY_MONTHLY = '$20'

const included: { icon: LucideIcon; label: string; body: string }[] = [
  { icon: Database, label: 'PostgreSQL', body: 'Project-scoped schemas, relations, indexes and real data.' },
  { icon: KeyRound, label: 'Auth', body: 'JWT sessions and per-project end-user tables.' },
  { icon: UploadCloud, label: 'Storage', body: 'Buckets, uploads, metadata and signed URLs.' },
  { icon: Radio, label: 'Realtime', body: 'SSE subscriptions, presence and broadcast channels.' },
  { icon: Zap, label: 'Triggers', body: 'Event workflows for inserts, updates, schedules and integrations. On Pro and Enterprise.' },
  { icon: RefreshCcw, label: 'Rollback', body: 'Deployment history and restore paths when changes need reversing.' },
  { icon: Bot, label: 'Autonomy', body: 'Watches your live backend every minute and repairs what is safe to repair. On every plan.' },
  { icon: Terminal, label: 'Bring your own agent', body: 'Drive the backend from Claude Code or Cursor over MCP. Typed tools carry no AI charge.' },
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
        { label: 'API requests', hint: 'No per-request fee or cap on any plan', cells: ['Unlimited', 'Unlimited', 'Unlimited'] },
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
        { label: 'File storage', cells: ['1\u00a0GB', metered('file_bytes'), 'Custom'] },
        { label: 'Egress', cells: ['5\u00a0GB', metered('egress_bytes'), 'Custom'] },
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
          cells: ['Hard caps, never billed', { value: 'Prepaid, only up to your spend limit', then: 'Off by default: every quota is a hard cap' }, 'Per contract'],
        },
        {
          label: 'Spend limit',
          hint: 'Paid in advance. Only an owner can raise it; agents and API keys can only read it',
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

/**
 * Backenly for Startups: two months of Pro at no cost for early-stage teams.
 *
 * Applying happens at /startups/apply, which Backenly Cloud provides: the
 * applicant describes the startup, confirms a code sent to an address at its
 * domain, then signs in or creates an account as usual. The founding team
 * reviews it, and approval switches Pro on for the pass. The months here must
 * stay equal to what the program grants (STARTUP_PASS_MONTHS in the Cloud
 * overlay's lib/billing/startup-program.ts).
 */
const STARTUP_MONTHS = 2
const PRO_MONTHLY_USD = 25

const STARTUP_APPLY_PATH = '/startups/apply'

const startupSources = ['Supabase', 'Appwrite', 'Firebase', 'Self-hosted', 'Starting fresh']

const startupPass = [
  `${PRO_INCLUDED.mau.toLocaleString('en-US')}\u00a0MAU, ${PRO_INCLUDED.dbGib}\u00a0GB Postgres, ${PRO_INCLUDED.fileGib}\u00a0GB files`,
  'Unlimited projects and API requests, 5 team seats',
  '3,000 AI credits every month',
  'Self-healing every minute, never metered',
  'Help from our team planning your move',
]

const startupSteps = [
  { title: 'Apply in two minutes', body: 'Tell us about your startup and confirm an email at its domain, then sign in as usual.' },
  { title: 'Get Pro switched on', body: `Once approved, Pro runs on your account for ${STARTUP_MONTHS} months. No card needed.` },
  { title: 'Move over and ship', body: 'Run production on Backenly. Your data stays standard Postgres, exportable anytime.' },
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
    a: 'Almost never; it depends which tool your agent calls. The typed MCP tools (create_table, add_column, set_rls, generate_types, run_query and the rest) compile straight to SQL with no model call, so they are free on every plan: your agent supplies the intelligence and you pay your own provider. The exception is the natural-language tools, backend_chat and generate_function, where Backenly runs its own model on your behalf. Those draw credits, and you are billed the tokens the call actually burned, nothing more. Point your agent at the typed tools and the AI meter stays at zero.',
  },
  {
    q: 'Does autonomy spend my credits?',
    a: 'Never. Detection and repair are deterministic: probes find drift, and each finding maps to a typed repair that compiles to SQL, with no model in the repair path, so there is nothing to bill you for. When the loop cannot fix something and escalates it to you, a model may write up the diagnosis you read; that pass is on us, never your credits. Every plan gets the identical loop: checks every minute, repairs everything it safely can, with no per-window cap and no monthly limit, Free included. We do not meter healing: a backend that stops repairing itself once you hit a quota is the exact failure we built this to remove. Plans differ on capacity (projects, users, storage, AI credits), never on whether your backend is allowed to stay healthy.',
  },
  {
    q: 'Are database, auth, storage and realtime paid add-ons?',
    a: 'No. Core backend primitives are included on every plan. Paid tiers increase capacity, support, rollback windows and advanced controls.',
  },
  {
    q: 'Am I locked in? Can I get my data out?',
    a: 'Your backend is standard PostgreSQL, and it stays yours. Every plan, Free included, gets a real read-only connection string (psql, TablePlus, any BI tool), an optional read-write one, and one-click pg_dump exports that restore on any Postgres: RDS, Neon, your own server. The platform is open source too, so a full self-hosted Backenly is always an exit path. Schema, data, constraints, indexes: everything leaves with you, anytime, with no exit fee.',
  },
  {
    q: 'Can I cancel anytime?',
    a: 'Yes. Paid access continues until the end of the billing period, then the account returns to the Free plan.',
  },
]

/** Shown only in a build that publishes usage pricing. */
const usageFaq = {
  q: 'What happens when I go past what Pro includes?',
  a: 'Nothing is billed unless you choose it. Pro’s quotas are shared by every project on your account, and your spend limit is off by default, so each quota is a hard cap. Set a limit ($50, $100, $250 or your own) and pay it in advance; usage then continues at the rates in the table, never past that limit, with emails at 50%, 80% and 100%. Each month’s usage is drawn from what you paid and the rest carries over, and projects, API requests, autonomy, the typed MCP tools, deploys and rollbacks are never billed at all.',
}

export default function PricingPage() {
  const router = useRouter()
  const { isLoggedIn } = useUserSession()
  const published = usagePricingPublished()
  const [cadence, setCadence] = useState<Cadence>('monthly')

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
      <Page>
        <PageHero
          trail={[{ label: 'Home', href: '/' }, { label: 'Pricing' }]}
          title="Start free, scale when usage proves it"
          lede="Every plan runs the full backend and the same self-healing loop. Paid plans add capacity, never uptime."
        />

        <Section flush aria-label="Plans">
          <StartupProgram />

          <div className="mt-[72px] flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between md:mt-[96px]">
            <h2 className={`text-[26px] text-white md:text-[34px] ${TITLE}`}>Plans</h2>
            <CadenceSwitch value={cadence} onChange={setCadence} />
          </div>

          {/* 1 -> 3, never 2 + 1: at two columns Enterprise orphans on a
              second row at half width across tablet widths. */}
          <div className="mt-8 grid gap-3 lg:grid-cols-3">
            {plans.map((plan) => (
              <PlanCard key={plan.name} plan={plan} cadence={cadence} onCta={handleCta} />
            ))}
          </div>

          {/* Portability guarantee: stated where buying decisions happen, not
              buried in the FAQ. Flat by design (locked pricing-page language). */}
          <p className="mt-6 max-w-[96ch] text-[14px] leading-[1.7] text-zinc-400">
            <span className="font-medium text-zinc-200">No lock-in, on every plan:</span>{' '}
            your backend is standard PostgreSQL with a real connection string, connect psql or any BI
            tool, and export a full <code className="font-mono text-[13px] text-zinc-300">pg_dump</code>{' '}
            backup that restores on any Postgres. And the platform itself is open source (Apache-2.0),
            so the exit path includes running Backenly on your own servers. Your data leaves with you,
            anytime, free plan included.
          </p>
        </Section>

        <Section aria-labelledby="included-title">
          <div className="grid gap-12 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-16">
            <Reveal>
              <SectionHead
                id="included-title"
                title="The backend is not split into add-ons"
                lede="Paid plans increase capacity and support. The primitives you need to build a real backend are there from the first project."
              />
            </Reveal>
            <Reveal delay={0.06}>
              <ul className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
                {included.map((item) => {
                  const ItemIcon = item.icon
                  return (
                    <li key={item.label} className="flex min-w-0 gap-4 border-t border-white/[0.08] pt-6">
                      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.09] bg-white/[0.03]">
                        <ItemIcon aria-hidden className="h-4 w-4 text-zinc-300" strokeWidth={1.75} />
                      </span>
                      <div className="min-w-0">
                        <h3 className={`text-[15px] text-white ${HEADING}`}>{item.label}</h3>
                        <p className="mt-1.5 text-[14px] leading-[1.6] text-zinc-400">{item.body}</p>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </Reveal>
          </div>
        </Section>

        <ComparisonSection published={published} onCta={handleCta} />

        <Section aria-labelledby="pricing-faq">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-16">
            <Reveal className="lg:sticky lg:top-28 lg:self-start">
              <SectionHead
                id="pricing-faq"
                title="Straight answers before you choose"
                lede="Anything else, ask the people who run it."
              />
              <a
                href={`mailto:${ROUTES.supportEmail}?subject=Backenly%20pricing%20question`}
                className="group mt-7 inline-flex items-center gap-1.5 rounded-sm text-[15px] font-medium text-zinc-300 transition-colors duration-200 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
              >
                Email a pricing question
                <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
              </a>
            </Reveal>
            <Reveal delay={0.06}>
              <Faq items={[...faqs, ...(published ? [usageFaq] : [])]} />
            </Reveal>
          </div>
        </Section>

        <HorizonClose
          title="Build the first backend for free"
          lede="No credit card. One live project. Upgrade only when your product needs more capacity."
        >
          <StartButton />
        </HorizonClose>
      </Page>
    </SiteShell>
  )
}

/* ── Plans ───────────────────────────────────────────────────────────────── */

function CadenceSwitch({ value, onChange }: { value: Cadence; onChange: (next: Cadence) => void }) {
  const options: { id: Cadence; label: string; note?: string }[] = [
    { id: 'monthly', label: 'Monthly' },
    { id: 'yearly', label: 'Yearly', note: 'Save 20%' },
  ]
  return (
    <div role="radiogroup" aria-label="Billing period" className="inline-flex self-start rounded-lg border border-white/[0.10] bg-white/[0.03] p-1">
      {options.map((option) => {
        const selected = value === option.id
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.id)}
            className={`inline-flex h-9 cursor-pointer items-center gap-2 rounded-md px-3.5 text-[14px] font-medium tracking-[-0.006em] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 ${
              selected ? 'bg-white text-black' : 'text-zinc-400 hover:text-white'
            }`}
          >
            {option.label}
            {option.note && (
              <span className={`text-[12px] font-medium ${selected ? 'text-violet-700' : 'text-violet-300'}`}>
                {option.note}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function PlanCard({ plan, cadence, onCta }: { plan: Plan; cadence: Cadence; onCta: () => void }) {
  const yearlyPro = plan.name === 'Pro' && cadence === 'yearly'
  const price = yearlyPro ? PRO_YEARLY_MONTHLY : plan.price
  const cadenceLabel = yearlyPro ? 'per month' : plan.cadence
  const priceNote =
    plan.name === 'Pro'
      ? yearlyPro
        ? `${PRO_YEARLY_TOTAL} billed yearly`
        : `or ${PRO_YEARLY_MONTHLY} a month, billed yearly`
      : plan.name === 'Free'
        ? 'No credit card'
        : 'Custom limits, invoiced'

  const ctaClass = `${plan.highlighted ? PRIMARY_CTA : SECONDARY_CTA} mt-8 w-full`

  return (
    <article
      className={`relative flex h-full flex-col overflow-hidden p-7 md:p-8 ${PANEL} ${
        plan.highlighted ? 'border-violet-300/25 shadow-[0_40px_120px_-60px_rgba(139,92,246,0.6)]' : ''
      }`}
    >
      {plan.highlighted && (
        <>
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(to_right,transparent,rgba(196,181,253,0.9),rgba(255,255,255,0.9),rgba(196,181,253,0.9),transparent)]"
          />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_45%_at_50%_0%,rgba(139,92,246,0.14),transparent)]"
          />
        </>
      )}

      <div className="relative flex h-full flex-col">
        <h3 className={`text-[18px] text-white ${HEADING}`}>{plan.name}</h3>
        <p className="mt-2 min-h-[48px] text-[14px] leading-[1.65] text-zinc-400">{plan.summary}</p>

        <p className="mt-7 flex items-baseline gap-2">
          <span className="text-[48px] font-semibold leading-none tracking-[-0.04em] text-white tabular-nums">{price}</span>
          <span className="text-[14px] text-zinc-500">{cadenceLabel}</span>
        </p>
        <p className="mt-3 text-[13px] text-zinc-500" aria-live="polite">
          {priceNote}
        </p>

        {plan.ctaHref ? (
          <a href={plan.ctaHref} className={ctaClass}>
            {plan.cta}
          </a>
        ) : (
          <button type="button" onClick={onCta} className={ctaClass}>
            {plan.cta}
            <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
          </button>
        )}

        <dl className="mt-8 border-t border-white/[0.08]">
          {plan.limits.map((limit) => (
            <div key={limit.label} className="flex items-baseline justify-between gap-4 border-b border-white/[0.06] py-3">
              <dt className="text-[14px] text-zinc-500">{limit.label}</dt>
              <dd className="text-right text-[14px] font-medium text-zinc-200">{limit.value}</dd>
            </div>
          ))}
        </dl>

        <ul className="mt-7 flex flex-col gap-3.5">
          {plan.features.map((feature) => (
            <li key={feature} className="flex gap-3 text-[14px] leading-[1.6] text-zinc-300">
              <Check aria-hidden className={`mt-[3px] h-4 w-4 shrink-0 ${plan.highlighted ? 'text-violet-300' : 'text-zinc-500'}`} strokeWidth={2} />
              <span>{feature}</span>
            </li>
          ))}
        </ul>

        <p className="mt-auto pt-8 text-[13px] leading-[1.6] text-zinc-500">
          Best for <span className="text-zinc-300">{plan.bestFor.charAt(0).toLowerCase() + plan.bestFor.slice(1)}</span>
        </p>
      </div>
    </article>
  )
}

/* ── Startups ────────────────────────────────────────────────────────────── */

/**
 * The startup program, first thing under the hero and above the plan cards, so
 * a founder meets the offer before comparing tiers. The pitch and the pass sit
 * side by side at lg and the three steps run along the bottom. Violet is the
 * only colour, as light: an edge along the top and a wash falling from it.
 */
function StartupProgram() {
  return (
    <section
      id="startups"
      aria-labelledby="startups-title"
      className={`relative scroll-mt-[92px] overflow-hidden rounded-2xl border border-violet-300/[0.18] ${INK}`}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(to_right,transparent,rgba(167,139,250,0.6),transparent)]"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_55%_at_25%_0%,rgba(139,92,246,0.12),transparent_70%)]"
      />

      <div className="relative grid gap-10 p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)] lg:gap-14 lg:p-12">
        <div className="min-w-0">
          <p className="text-[14px] font-medium tracking-[-0.006em] text-violet-200">Backenly for Startups</p>
          <h2
            id="startups-title"
            className={`mt-4 max-w-[20ch] text-[30px] text-white [text-wrap:balance] md:text-[40px] ${TITLE}`}
          >
            Startups get Pro free for {STARTUP_MONTHS} months
          </h2>
          <p className="mt-5 max-w-[58ch] text-[16px] leading-[1.7] text-zinc-400">
            Switching from Supabase, Appwrite, Firebase, or a backend you run yourself? Apply once and
            your team gets the complete Pro plan at no cost: enough time to move a real product over
            and judge Backenly on production traffic, not a demo.
          </p>

          <p className="mt-8 text-[13px] text-zinc-500">Coming from</p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {startupSources.map((source) => (
              <li
                key={source}
                className="rounded-md border border-white/[0.10] bg-white/[0.03] px-3 py-1.5 text-[14px] text-zinc-300"
              >
                {source}
              </li>
            ))}
          </ul>

          <div className="mt-9">
            <Link href={STARTUP_APPLY_PATH} className={PRIMARY_CTA}>
              Apply for startup access
              <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
            </Link>
          </div>
          <p className="mt-4 max-w-[58ch] text-[13px] leading-[1.6] text-zinc-500">
            For early-stage teams, bootstrapped through Series A. One pass per company, and every
            application is read by the founding team.
          </p>
        </div>

        <StartupPass />
      </div>

      {/* A real sequence, so it is numbered. */}
      <ol className="relative grid divide-y divide-white/[0.08] border-t border-white/[0.08] md:grid-cols-3 md:divide-x md:divide-y-0">
        {startupSteps.map((step, i) => (
          <li key={step.title} className="p-6 sm:px-8 lg:px-12 lg:py-8">
            <p className="text-[13px] tabular-nums text-violet-300">Step {i + 1}</p>
            <h3 className={`mt-2 text-[16px] text-white ${HEADING}`}>{step.title}</h3>
            <p className="mt-1.5 text-[14px] leading-[1.6] text-zinc-400">{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}

/** The offer itself, drawn as a pass: a price you keep, torn from what it is worth. */
function StartupPass() {
  return (
    <div className="relative self-start rounded-2xl border border-white/[0.12] bg-black/50 shadow-[0_40px_120px_-60px_rgba(139,92,246,0.55)]">
      <div className="p-6 sm:p-7">
        <div className="flex items-center justify-between gap-4">
          <p className="text-[14px] font-medium text-violet-200">Startup pass</p>
          <span className="rounded-md border border-white/[0.10] bg-white/[0.04] px-2 py-1 text-[12px] font-medium text-zinc-300">
            Pro plan
          </span>
        </div>
        <div className="mt-6 flex items-end gap-3">
          <span className="text-[60px] font-semibold leading-none tracking-[-0.04em] text-white">$0</span>
          <div className="pb-1 text-[14px]">
            <p className="text-zinc-500">
              <s className="decoration-zinc-500">
                <span className="sr-only">Regular price </span>${PRO_MONTHLY_USD * STARTUP_MONTHS}
              </s>{' '}
              value
            </p>
            <p className="text-zinc-300">for your first {STARTUP_MONTHS} months</p>
          </div>
        </div>
        <p className="mt-4 text-[13px] text-zinc-500">
          Normally ${PRO_MONTHLY_USD} a month. Nothing to pay while the pass runs.
        </p>
      </div>

      {/* The tear line: a dashed rule with a notch bitten out of each edge. The
          notches are filled with the band's own ink, so they read as holes. */}
      <div aria-hidden className="relative h-px">
        <span className="absolute inset-x-6 top-0 border-t border-dashed border-white/15" />
        <span className="absolute -left-[11px] -top-[11px] h-[22px] w-[22px] rounded-full border border-white/[0.12] bg-[#0a0b0d] [clip-path:inset(0_0_0_50%)]" />
        <span className="absolute -right-[11px] -top-[11px] h-[22px] w-[22px] rounded-full border border-white/[0.12] bg-[#0a0b0d] [clip-path:inset(0_50%_0_0)]" />
      </div>

      <div className="p-6 sm:p-7">
        <p className="text-[13px] text-zinc-500">Included on the pass</p>
        <ul className="mt-4 flex flex-col gap-3">
          {startupPass.map((item) => (
            <li key={item} className="flex gap-3 text-[14px] leading-[1.6] text-zinc-300">
              <Check aria-hidden className="mt-[3px] h-4 w-4 shrink-0 text-violet-300" strokeWidth={2.25} />
              <span>{item}</span>
            </li>
          ))}
        </ul>
        <p className="mt-6 border-t border-white/[0.08] pt-5 text-[13px] leading-[1.6] text-zinc-500">
          When the {STARTUP_MONTHS} months end, you choose: stay on Pro at ${PRO_MONTHLY_USD} a month,
          or return to Free and keep your project. Nothing renews without your say.
        </p>
      </div>
    </div>
  )
}

/* ── Comparison ──────────────────────────────────────────────────────────── */

/**
 * The plan comparison, grouped the way people compare backends: each row states
 * what a plan includes and, for Pro's metered quantities, the rate past it.
 *
 * The plan header sticks under the navbar (68px), so row 30 still says which
 * column is which. That needs the table's ancestors to have no overflow set,
 * which is why the frame is a border and not an overflow-hidden card. On small
 * screens every row becomes a card with the three plans side by side.
 */
function ComparisonSection({ published, onCta }: { published: boolean; onCta: () => void }) {
  const groups = comparisonGroups(published)
  const heads = [
    { name: 'Free', price: '$0', cadence: 'forever', cta: 'Start free' },
    { name: 'Pro', price: '$25', cadence: 'per month', cta: 'Get Pro' },
    { name: 'Enterprise', price: 'Custom', cadence: 'annual', cta: 'Talk to us' },
  ]
  return (
    <Section aria-labelledby="compare-title">
      <Reveal>
        <SectionHead
          id="compare-title"
          title="Capacity changes. The core runtime stays."
          lede={
            published
              ? 'Pro’s quotas are shared by every project on your account. Past them, nothing is billed unless you set a spend limit and pay it in advance; with one, usage continues at the rates shown, never past it.'
              : 'Running at company scale? Enterprise adds custom limits, SSO, onboarding and migration help, and a 12-hour SLA.'
          }
        />
      </Reveal>

      <div className="mt-10 flex flex-col gap-10 md:hidden">
        {groups.map((group) => (
          <div key={group.title}>
            <GroupTitle group={group} />
            <div className="mt-4 grid gap-3">
              {group.rows.map((row) => (
                <div key={row.label} className={`p-5 ${PANEL}`}>
                  <h3 className="text-[15px] font-medium text-white">{row.label}</h3>
                  {row.hint && <p className="mt-1 text-[13px] text-zinc-500">{row.hint}</p>}
                  <div className="mt-4 grid grid-cols-3 gap-3 text-[14px]">
                    {row.cells.map((cell, i) => (
                      <div key={heads[i].name} className="min-w-0">
                        <p className="text-[12px] text-zinc-500">{heads[i].name}</p>
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

      <div className="mt-12 hidden rounded-2xl border border-white/[0.08] md:block">
        <table className="w-full table-fixed border-separate border-spacing-0 text-left">
          <caption className="sr-only">Backenly plans compared, feature by feature</caption>
          <colgroup>
            <col className="w-[31%]" />
            <col />
            <col className="bg-[linear-gradient(180deg,rgba(139,92,246,0.06),rgba(139,92,246,0.015))]" />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th className="sticky top-[68px] z-10 rounded-tl-2xl border-b border-white/[0.08] bg-[#0a0b0d] px-6 py-5">
                <span className="sr-only">Feature</span>
              </th>
              {heads.map((head, i) => (
                <th
                  key={head.name}
                  scope="col"
                  className={`sticky top-[68px] z-10 border-b border-white/[0.08] bg-[#0a0b0d] px-6 py-5 align-top font-normal ${
                    i === heads.length - 1 ? 'rounded-tr-2xl' : ''
                  }`}
                >
                  <p className={`text-[15px] font-semibold ${head.name === 'Pro' ? 'text-violet-200' : 'text-white'}`}>{head.name}</p>
                  <p className="mt-1">
                    <span className="text-[20px] font-semibold tracking-[-0.02em] text-white tabular-nums">{head.price}</span>
                    <span className="ml-1.5 text-[13px] text-zinc-500">{head.cadence}</span>
                  </p>
                  {head.name === 'Enterprise' ? (
                    <a
                      href="mailto:support@backenly.com?subject=Backenly%20Enterprise"
                      className="mt-4 inline-flex h-9 w-full items-center justify-center rounded-lg border border-white/[0.12] bg-white/[0.03] text-[13px] font-semibold text-zinc-200 transition-colors duration-200 hover:border-white/25 hover:bg-white/[0.07] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
                    >
                      {head.cta}
                    </a>
                  ) : (
                    <button
                      type="button"
                      onClick={onCta}
                      className={`mt-4 inline-flex h-9 w-full cursor-pointer items-center justify-center rounded-lg text-[13px] font-semibold transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 ${
                        head.name === 'Pro'
                          ? 'bg-white text-black hover:bg-zinc-200'
                          : 'border border-white/[0.12] bg-white/[0.03] text-zinc-200 hover:border-white/25 hover:bg-white/[0.07] hover:text-white'
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
            <tbody key={group.title}>
              <tr>
                <th colSpan={4} scope="colgroup" className="px-6 pb-3 pt-9 text-left font-normal">
                  <GroupTitle group={group} />
                </th>
              </tr>
              {group.rows.map((row) => (
                <tr key={row.label}>
                  <th scope="row" className="border-t border-white/[0.06] px-6 py-4 align-top font-normal">
                    <p className="text-[14px] font-medium text-zinc-200">{row.label}</p>
                    {row.hint && <p className="mt-1 text-[13px] leading-[1.5] text-zinc-500">{row.hint}</p>}
                  </th>
                  {row.cells.map((cell, i) => (
                    <td key={heads[i].name} className="border-t border-white/[0.06] px-6 py-4 align-top text-[14px]">
                      <CellView cell={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </Section>
  )
}

function GroupTitle({ group }: { group: MatrixGroup }) {
  const GroupIcon = group.icon
  return (
    <span className="inline-flex items-center gap-3">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.09] bg-white/[0.03]">
        <GroupIcon aria-hidden className="h-4 w-4 text-zinc-300" strokeWidth={1.75} />
      </span>
      <span className={`text-[16px] text-white ${HEADING}`}>{group.title}</span>
    </span>
  )
}

function CellView({ cell }: { cell: Cell }): ReactNode {
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
      {cell.then && <p className="mt-1 text-[13px] leading-[1.5] text-zinc-500">{cell.then}</p>}
    </div>
  )
}
