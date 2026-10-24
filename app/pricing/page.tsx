'use client'

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowDown,
  ArrowRight,
  Bot,
  Check,
  Database,
  KeyRound,
  Layers,
  LifeBuoy,
  Minus,
  Radio,
  ShieldCheck,
  UploadCloud,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { ROUTES, SiteShell } from '@/components/site/SiteShell'
import { HorizonClose, Page, Section, SectionHead } from '@/components/site/kit'
import { Faq } from '@/components/site/Faq'
import { StartButton } from '@/components/site/StartButton'
import { CONTAINER, DISPLAY, HEADING, LEDE, PRIMARY_CTA, SECONDARY_CTA, TEXT_LINK } from '@/components/site/tokens'
import { useUserSession } from '@/lib/hooks/useUserSession'
import {
  PRO_INCLUDED,
  proUsagePriceRows,
  usagePricingPublished,
  type OverageAxis,
} from '@/lib/pricing/catalog'

/* ─────────────────────────────────────────────────────────────
   /pricing (2026-10-15, founders: "make pricing better, check supabase.com,
   appwrite.io"). Read against the pricing pages of Supabase, Appwrite and
   Vercel, which share one shape: the plans side by side in one frame, each
   led by its price, then who it is for, the button, and "everything in the
   plan before, plus"; then one long comparison table whose plan header
   sticks. No feature band between them (founders: "remove all these texts").

   Unchanged on purpose: every number, every plan row, the catalog-driven
   rates (a rate only appears once lib/pricing/catalog.ts publishes it), the
   monthly / yearly switch, the checkout path and the FAQ's facts.

   Self-healing is identical on every plan (every minute, no cap, never billed
   to AI credits). It is listed once, on Free, and reaches the other plans
   through "Everything in Free, plus", so it can never read as a reason to
   upgrade. Violet marks one thing: the recommended plan.

   The comparison is one table at every width. From md up the plan header
   sticks under the navbar (68px), which needs no overflow on its ancestors;
   below md the table scrolls inside its own focusable region with the row
   labels pinned, so the page itself never scrolls sideways.

   The startup program is not on this page. It has its own page at /startups,
   which Backenly Cloud provides together with the application behind it.
───────────────────────────────────────────────────────────── */

type Cadence = 'monthly' | 'yearly'

type PlanItem = { text: string; note?: string | null }

type Plan = {
  name: 'Free' | 'Pro' | 'Enterprise'
  summary: string
  cta: string
  ctaHref?: string
  highlighted?: boolean
  listTitle: string
  items: PlanItem[]
}

const ENTERPRISE_MAIL = `mailto:${ROUTES.supportEmail}?subject=Backenly%20Enterprise`

/** Pro billed yearly: $240 a year, which is $20 a month. */
const PRO_MONTHLY = '$25'
const PRO_YEARLY_TOTAL = '$240'
const PRO_YEARLY_MONTHLY = '$20'

/**
 * The three plans. Pro's metered amounts come from lib/pricing/catalog.ts, and
 * the rate past each one is shown only in a build that publishes usage pricing
 * and only once the catalog publishes that axis's rate.
 */
function plansFor(published: boolean): Plan[] {
  const pro = new Map(proUsagePriceRows().map((r) => [r.axis, r]))
  const then = (axis: OverageAxis) => {
    const rate = pro.get(axis)?.rate
    return published && rate ? `then ${rate}` : null
  }

  return [
    {
      name: 'Free',
      summary: 'For prototypes and first experiments.',
      cta: 'Start free',
      listTitle: 'Includes',
      items: [
        { text: '1 live project' },
        { text: '50,000 monthly active users' },
        { text: '512 MB Postgres database' },
        { text: '1 GB file storage' },
        { text: '200 AI credits a month' },
        { text: 'Unlimited API requests' },
        { text: 'Self-healing every minute', note: 'Never capped and never metered' },
        { text: 'Community support' },
      ],
    },
    {
      name: 'Pro',
      summary: 'For products with real users, agencies and small teams.',
      cta: 'Get Pro',
      highlighted: true,
      listTitle: 'Everything in Free, plus',
      items: [
        { text: 'Unlimited projects' },
        { text: `${PRO_INCLUDED.mau.toLocaleString('en-US')} monthly active users`, note: then('mau') },
        { text: `${PRO_INCLUDED.dbGib} GB Postgres database`, note: then('db_bytes') },
        { text: `${PRO_INCLUDED.fileGib} GB file storage`, note: then('file_bytes') },
        { text: '3,000 AI credits a month' },
        { text: `${PRO_INCLUDED.fnRuns / 1_000_000}M function runs a month`, note: then('fn_runs') },
        { text: 'Event triggers, outbound webhooks and custom domains' },
        { text: '5 team seats with project-level access' },
        { text: 'Full deployment history and rollback' },
        { text: '30 days of logs and email support' },
      ],
    },
    {
      name: 'Enterprise',
      summary: 'For companies that need custom limits, isolation and an SLA.',
      cta: 'Talk to us',
      ctaHref: ENTERPRISE_MAIL,
      listTitle: 'Everything in Pro, plus',
      items: [
        { text: 'Custom limits and a custom AI credit pool' },
        { text: 'Single sign-on (OIDC)' },
        { text: 'Custom guardrail policies for your compliance requirements' },
        { text: '90 days of logs' },
        { text: 'Dedicated support with a 12-hour SLA' },
        { text: 'Help with onboarding and migration' },
        { text: 'Invoiced billing that works with procurement' },
      ],
    },
  ]
}

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
 * catalog publishes that axis's rate.
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
        { label: 'Team seats', cells: ['2', '5, with project-level access', 'Custom'] },
      ],
    },
    {
      icon: Database,
      title: 'Database',
      rows: [
        { label: 'Postgres database', hint: 'Shared by every project on your account', cells: ['512 MB', metered('db_bytes'), 'Custom'] },
        { label: 'API requests', hint: 'No cap and no per-request fee on any plan', cells: ['Unlimited', 'Unlimited', 'Unlimited'] },
        { label: 'Daily backups', cells: ['7 days kept', '7 days kept', '7 days kept'] },
        { label: 'Direct Postgres access and pg_dump export', cells: [true, true, true] },
        // How long a change's restore point is kept follows log retention
        // (lib/changes/policy.ts). Whether a given change can still be restored
        // is decided per change, so this is retention, not a promise.
        { label: 'Schema change restore points kept', hint: 'Each change shows whether the state before it can still be restored', cells: ['7 days', '30 days', '90 days'] },
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
        { label: 'File storage', cells: ['1 GB', metered('file_bytes'), 'Custom'] },
        { label: 'Egress', cells: ['5 GB', metered('egress_bytes'), 'Custom'] },
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
        { label: 'Build over MCP with your own agent', hint: 'The typed tools never use credits', cells: ['No charge', 'No charge', 'No charge'] },
        { label: 'Self-healing', hint: 'Checks every minute and repairs what is safe', cells: ['Never metered', 'Never metered', 'Never metered'] },
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

const faqs = [
  {
    q: 'Can I start without a credit card?',
    a: 'Yes. The Free plan creates one permanent live project with enough capacity to validate a real backend.',
  },
  {
    q: 'Can I self-host Backenly instead of paying?',
    a: 'Yes. The platform is open source under Apache-2.0 and free to self-host. You bring the servers, the Postgres, and an AI provider key (Claude or OpenAI) if you want the natural-language build tools. The self-healing loop itself needs no model. The plans on this page are Backenly Cloud, where we run the infrastructure and handle backups and upgrades. It is the same codebase either way, and pg_dump moves your data between the two.',
  },
  {
    q: 'What counts as an AI credit?',
    a: 'One credit is 1,000 tokens of Backenly’s own model usage. Credits are spent only when Backenly runs its own model for you: the natural-language MCP tool (backend_chat), including the model-driven steps inside that turn, such as the architect and function generation. The dashboard assistant answers questions free, the typed MCP tools cost nothing, and self-healing never uses credits.',
  },
  {
    q: 'Does driving the backend from my coding agent cost credits?',
    a: 'Almost never. It depends on which tool your agent calls. The typed MCP tools (create_table, add_column, set_rls, generate_types, run_query and the rest) compile straight to SQL with no model call, so they are free on every plan: your agent supplies the reasoning and you pay your own provider. The exception is the natural-language tools, backend_chat and generate_function, where Backenly runs its own model for you. Those use credits, and you are billed only the tokens the call used. An agent that sticks to the typed tools uses no credits.',
  },
  {
    q: 'Does self-healing spend my credits?',
    a: 'No. Detection and repair are deterministic: probes find drift, and each finding maps to a typed repair that compiles to SQL, with no model in the repair path. When the loop cannot fix something and escalates it to you, a model may write the diagnosis you read; we pay for that, not your credits. Every plan, Free included, gets the same loop: a check every minute, repairs for everything it can do safely, no per-window cap and no monthly limit. Healing is never metered, so your backend keeps repairing itself after you reach a quota. Plans differ on capacity (projects, users, storage, AI credits), not on self-healing.',
  },
  {
    q: 'Are database, auth, storage and realtime paid add-ons?',
    a: 'No. They are included on every plan. Paid plans raise capacity and add support, rollback history and advanced controls.',
  },
  {
    q: 'Am I locked in? Can I get my data out?',
    a: 'You are not locked in, and your data can always leave. Your backend is standard PostgreSQL and it stays yours. Every plan, Free included, gets a read-only connection string (psql, TablePlus, any BI tool), an optional read-write one, and one-click pg_dump exports that restore on any Postgres: RDS, Neon, your own server. The platform is open source too, so you can also move to a self-hosted Backenly. Schema, data, constraints and indexes all leave with you, at any time, with no exit fee.',
  },
  {
    q: 'Can I cancel anytime?',
    a: 'Yes. Paid access continues until the end of the billing period, then the account returns to the Free plan.',
  },
]

/** Shown only in a build that publishes usage pricing. */
const usageFaq = {
  q: 'What happens when I go past what Pro includes?',
  a: 'Nothing is billed unless you choose it. Pro’s quotas are shared by every project on your account, and your spend limit is off by default, so each quota is a hard cap. Set a limit ($50, $100, $250 or your own) and pay it in advance. Usage then continues at the rates in the table, never past that limit, with emails at 50%, 80% and 100%. Each month’s usage is drawn from what you paid and the rest carries over. Projects, API requests, self-healing, the typed MCP tools, deploys and rollbacks are never billed.',
}

export default function PricingPage() {
  const router = useRouter()
  const { isLoggedIn } = useUserSession()
  const published = usagePricingPublished()
  const [cadence, setCadence] = useState<Cadence>('monthly')
  const plans = plansFor(published)

  function handleCta() {
    if (!isLoggedIn) {
      router.push(ROUTES.signup)
      return
    }

    // Billing was promoted out of settings into its own org page. The legacy
    // `?tab=billing` deep link still works, but only because settings/page.tsx
    // catches it and redirects, so sending people through it costs a needless
    // client-side bounce. Go straight to the real page.
    router.push('/app/billing')
  }

  return (
    <SiteShell>
      <Page>
        {/* A small header in the same frame as the plans (founders, 2026-10-15,
            pointing at InsForge's pricing page: "no need for this kind of big
            banner"). One title, one line, the billing switch, then the plans:
            the plans read as one decision rather than three adverts.
            Columns go 1 -> 3, never 2 + 1. */}
        <section aria-labelledby="pricing-title" className="relative isolate pt-[32px] md:pt-[48px]">
          <div className={CONTAINER}>
            <div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.012]">
              <header className="relative isolate border-b border-white/[0.07] px-[20px] pb-[40px] pt-[44px] text-center md:pb-[48px] md:pt-[60px]">
                {/* The site's key light, centred over the title. */}
                <div
                  aria-hidden
                  className="pointer-events-none absolute left-1/2 top-[-200px] -z-10 h-[440px] w-[820px] max-w-none -translate-x-1/2 bg-[radial-gradient(closest-side,rgba(255,255,255,0.07),transparent)]"
                />
                <h1
                  id="pricing-title"
                  className={`hero-enter bg-gradient-to-b from-white from-40% to-zinc-400 bg-clip-text pb-[4px] text-[40px] text-transparent md:text-[52px] ${DISPLAY}`}
                >
                  Pricing
                </h1>
                <p className={`hero-enter hero-enter-1 mx-auto mt-[12px] max-w-[52ch] text-[16px] text-zinc-400 [text-wrap:balance] md:text-[18px] ${LEDE}`}>
                  Start free. Upgrade when you need more capacity.
                </p>
                <div className="hero-enter hero-enter-2 mt-[28px] flex justify-center">
                  <CadenceSwitch value={cadence} onChange={setCadence} />
                </div>
              </header>

              <h2 className="sr-only">Plans</h2>
              <div className="grid lg:grid-cols-3">
                {plans.map((plan, index) => (
                  <PlanColumn key={plan.name} plan={plan} cadence={cadence} onCta={handleCta} divided={index > 0} />
                ))}
              </div>
            </div>

            <p className="mt-[20px] text-center">
              <a href="#compare" className={`${TEXT_LINK} text-[14px]`}>
                Compare all features
                <ArrowDown aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-y-0.5" />
              </a>
            </p>
          </div>
        </section>

        <ComparisonSection published={published} cadence={cadence} onCta={handleCta} />

        <Section aria-labelledby="pricing-faq">
          <div className="grid gap-[40px] lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-[64px]">
            <div className="lg:sticky lg:top-[112px] lg:self-start">
              <SectionHead id="pricing-faq" title="Questions about plans and billing" />
              <p className="mt-[20px] max-w-[36ch] text-[15px] leading-[1.7] text-zinc-400">
                Anything else, ask the people who run it.
              </p>
              <a
                href={`mailto:${ROUTES.supportEmail}?subject=Backenly%20pricing%20question`}
                className={`mt-[24px] ${TEXT_LINK}`}
              >
                Email a pricing question
                <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
              </a>
            </div>
            <Faq items={[...faqs, ...(published ? [usageFaq] : [])]} />
          </div>
        </Section>

        <HorizonClose
          title="Start with one free project"
          lede="No credit card. Move to Pro when your product needs more capacity."
        >
          <StartButton />
        </HorizonClose>
      </Page>
    </SiteShell>
  )
}

/* ── Plans ───────────────────────────────────────────────────────────────── */

/**
 * The billing period as a segmented control. A radio group with a roving tab
 * stop: Tab reaches the selected option, the arrow keys move between them.
 */
function CadenceSwitch({ value, onChange }: { value: Cadence; onChange: (next: Cadence) => void }) {
  const options: { id: Cadence; label: string; note?: string }[] = [
    { id: 'monthly', label: 'Monthly' },
    { id: 'yearly', label: 'Yearly', note: 'Save 20%' },
  ]
  const refs = useRef<(HTMLButtonElement | null)[]>([])

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const steps: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }
    const step = steps[event.key]
    if (!step) return
    event.preventDefault()
    const next = (index + step + options.length) % options.length
    onChange(options[next].id)
    refs.current[next]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label="Billing period"
      className="inline-flex shrink-0 rounded-[8px] border border-white/[0.10] bg-white/[0.03] p-[3px]"
    >
      {options.map((option, index) => {
        const selected = value === option.id
        return (
          <button
            key={option.id}
            ref={(el) => {
              refs.current[index] = el
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={`inline-flex h-[34px] cursor-pointer items-center gap-[8px] rounded-[6px] px-[14px] text-[14px] font-medium tracking-[-0.006em] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 ${
              selected
                ? 'bg-white/[0.10] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {option.label}
            {option.note && (
              <span
                className={`rounded-[5px] px-[6px] py-[1px] text-[12px] font-medium ${
                  selected ? 'bg-white/[0.12] text-zinc-100' : 'bg-white/[0.05] text-zinc-400'
                }`}
              >
                {option.note}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function PlanColumn({
  plan,
  cadence,
  onCta,
  divided,
}: {
  plan: Plan
  cadence: Cadence
  onCta: () => void
  divided: boolean
}) {
  const yearly = cadence === 'yearly'
  const price = plan.name === 'Free' ? '$0' : plan.name === 'Pro' ? (yearly ? PRO_YEARLY_MONTHLY : PRO_MONTHLY) : 'Custom'
  const unit = plan.name === 'Enterprise' ? null : '/month'
  const priceNote =
    plan.name === 'Free'
      ? 'Free forever. No credit card.'
      : plan.name === 'Pro'
        ? yearly
          ? `Billed yearly at ${PRO_YEARLY_TOTAL}, or ${PRO_MONTHLY} month to month`
          : `Or ${PRO_YEARLY_MONTHLY} a month, billed yearly`
        : 'Annual agreement, invoiced'

  const ctaClass = `${plan.highlighted ? PRIMARY_CTA : SECONDARY_CTA} w-full`

  return (
    <article
      aria-labelledby={`plan-${plan.name}`}
      className={`flex min-w-0 flex-col p-[24px] sm:p-[28px] md:p-[32px] ${
        divided ? 'border-t border-white/[0.07] lg:border-l lg:border-t-0' : ''
      } ${plan.highlighted ? 'bg-white/[0.035] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]' : ''}`}
    >
      <div className="flex min-h-[26px] items-center justify-between gap-[12px]">
        <h3 id={`plan-${plan.name}`} className={`text-[17px] text-white ${HEADING}`}>
          {plan.name}
        </h3>
        {plan.highlighted && (
          <span className="rounded-[6px] border border-violet-300/25 bg-violet-400/[0.08] px-[8px] py-[2px] text-[12px] font-medium text-violet-200">
            Recommended
          </span>
        )}
      </div>

      <p className="mt-[20px] flex flex-wrap items-baseline gap-x-[8px] gap-y-[4px]">
        <span className="text-[44px] font-semibold leading-none tracking-[-0.04em] text-white tabular-nums">{price}</span>
        {plan.name === 'Pro' && yearly && (
          <s className="text-[20px] font-medium tracking-[-0.02em] text-zinc-500 tabular-nums">
            <span className="sr-only">Month to month: </span>
            {PRO_MONTHLY}
          </s>
        )}
        {unit && <span className="text-[15px] text-zinc-500">{unit}</span>}
      </p>
      <p className="mt-[10px] text-[13px] text-zinc-500" aria-live="polite">
        {priceNote}
      </p>

      <p className="mt-[16px] text-[15px] leading-[1.6] tracking-[-0.004em] text-zinc-400 [text-wrap:pretty] lg:min-h-[48px]">
        {plan.summary}
      </p>

      <div className="mt-[24px]">
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
      </div>

      <div className="mt-[28px] border-t border-white/[0.07] pt-[24px]">
        <p className="text-[13px] font-medium text-zinc-300">{plan.listTitle}</p>
        <ul className="mt-[14px] flex flex-col gap-[11px]">
          {plan.items.map((item) => (
            <li key={item.text} className="flex gap-[10px] text-[14px] leading-[1.55] text-zinc-300">
              <Check aria-hidden className="mt-[3px] h-[15px] w-[15px] shrink-0 text-zinc-500" strokeWidth={2} />
              <span className="min-w-0 [text-wrap:pretty]">
                {item.text}
                {item.note && <span className="mt-[2px] block text-[13px] text-zinc-500">{item.note}</span>}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </article>
  )
}

/* ── Comparison ──────────────────────────────────────────────────────────── */

/** Solid ground for the cells that stick, so rows scrolling under them are hidden. */
const STUCK = 'bg-[#08090a]'

function ComparisonSection({ published, cadence, onCta }: { published: boolean; cadence: Cadence; onCta: () => void }) {
  const groups = comparisonGroups(published)
  const yearly = cadence === 'yearly'
  const heads = [
    { name: 'Free', price: '$0', unit: '/month', cta: 'Start free' },
    {
      name: 'Pro',
      price: yearly ? PRO_YEARLY_MONTHLY : PRO_MONTHLY,
      unit: yearly ? '/month, billed yearly' : '/month',
      cta: 'Get Pro',
    },
    { name: 'Enterprise', price: 'Custom', unit: 'annual', cta: 'Talk to us' },
  ]
  // The row label column stays in view while a phone scrolls the plans sideways.
  // Solid only below md: from md up the frame does not clip, so a solid square
  // cell in the last row would paint over the frame's rounded corner. Written
  // out in full because Tailwind only generates classes it finds literally.
  const pinned = 'max-md:sticky max-md:left-0 max-md:z-[1] max-md:bg-[#08090a]'
  const button =
    'mt-[14px] inline-flex h-[36px] w-full cursor-pointer items-center justify-center rounded-[8px] text-[13px] font-semibold transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300'
  const quietButton = `${button} border border-white/[0.12] bg-white/[0.03] text-zinc-200 hover:border-white/25 hover:bg-white/[0.07] hover:text-white`

  return (
    <Section id="compare" aria-labelledby="compare-title" className="scroll-mt-[72px]">
      <SectionHead
        id="compare-title"
        title={
          <>
            Compare the plans.{' '}
            <span className="text-zinc-500">Every limit, side by side.</span>
          </>
        }
        lede={
          published
            ? 'Pro’s quotas are shared by every project on your account. Past a quota, nothing is billed unless you set a spend limit and pay it in advance. Usage then continues at the rates shown, never past that limit.'
            : 'Enterprise adds custom limits, single sign-on, onboarding and migration help, and a 12-hour SLA.'
        }
      />

      <div
        role="region"
        aria-label="Plan comparison table"
        tabIndex={0}
        className="mt-[48px] overflow-x-auto rounded-2xl border border-white/[0.07] focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 md:mt-[64px] md:overflow-visible"
      >
        <table className="w-full min-w-[600px] table-fixed border-separate border-spacing-0 text-left md:min-w-0">
          <caption className="sr-only">Backenly plans compared, feature by feature</caption>
          <colgroup>
            <col className="w-[28%] md:w-[31%]" />
            <col />
            <col className="bg-white/[0.022]" />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th
                className={`${STUCK} ${pinned} rounded-tl-2xl border-b border-white/[0.08] px-[20px] py-[20px] align-bottom md:sticky md:top-[68px] md:z-10 md:px-[24px]`}
              >
                <span className="sr-only">Feature</span>
              </th>
              {heads.map((head, i) => (
                <th
                  key={head.name}
                  scope="col"
                  className={`border-b border-white/[0.08] px-[16px] py-[20px] align-top font-normal md:sticky md:top-[68px] md:z-10 md:px-[24px] ${
                    head.name === 'Pro' ? 'bg-[#0d0e0f]' : STUCK
                  } ${i === heads.length - 1 ? 'rounded-tr-2xl' : ''}`}
                >
                  <p className="text-[15px] font-semibold text-white">{head.name}</p>
                  <p className="mt-[4px] flex flex-wrap items-baseline gap-x-[6px]">
                    <span className="text-[20px] font-semibold tracking-[-0.02em] text-white tabular-nums">{head.price}</span>
                    <span className="text-[13px] text-zinc-500">{head.unit}</span>
                  </p>
                  {head.name === 'Enterprise' ? (
                    <a href={ENTERPRISE_MAIL} className={quietButton}>
                      {head.cta}
                    </a>
                  ) : (
                    <button
                      type="button"
                      onClick={onCta}
                      className={head.name === 'Pro' ? `${button} bg-white text-black hover:bg-zinc-200` : quietButton}
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
                <th colSpan={4} scope="colgroup" className="px-[20px] pb-[12px] pt-[36px] text-left font-normal md:px-[24px]">
                  <GroupTitle group={group} />
                </th>
              </tr>
              {group.rows.map((row) => (
                <tr key={row.label}>
                  <th
                    scope="row"
                    className={`${pinned} border-t border-white/[0.06] px-[20px] py-[14px] align-top font-normal md:px-[24px]`}
                  >
                    <p className="text-[14px] font-medium leading-[1.5] text-zinc-200">{row.label}</p>
                    {row.hint && <p className="mt-[4px] text-[13px] leading-[1.5] text-zinc-500">{row.hint}</p>}
                  </th>
                  {row.cells.map((cell, i) => (
                    <td key={heads[i].name} className="border-t border-white/[0.06] px-[16px] py-[14px] align-top text-[14px] leading-[1.5] md:px-[24px]">
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
  // Pinned on a phone, so the group's name stays put while the plans scroll.
  return (
    <span className="flex w-max items-center gap-[10px] max-md:sticky max-md:left-[20px]">
      <GroupIcon aria-hidden className="h-4 w-4 text-zinc-500" strokeWidth={1.75} />
      <span className={`text-[15px] text-white ${HEADING}`}>{group.title}</span>
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
      {cell.then && <p className="mt-[4px] text-[13px] leading-[1.5] text-zinc-500">{cell.then}</p>}
    </div>
  )
}
