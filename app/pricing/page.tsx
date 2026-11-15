'use client'

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowDown,
  ArrowRight,
  Bot,
  Check,
  Database,
  Github,
  HeartPulse,
  KeyRound,
  Layers,
  LifeBuoy,
  Minus,
  Radio,
  Receipt,
  ShieldCheck,
  UploadCloud,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { ROUTES, SiteShell } from '@/components/site/SiteShell'
import { CloseBox, Page, Section, SectionHead } from '@/components/site/kit'
import { Box, BoxHead, Cells, Light } from '@/components/landing-v8/Box'
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
   upgrade. The recommended plan is marked by a white top edge, a lighter
   surface and the word "Recommended", never by colour alone.

   Less violet (founders, 2026-11-15, with Blaxel's pricing page: "reduce
   purple gradient colors"): the painted light runs at well under half
   strength in the head and the billing box, and none sits on a plan; the
   page ends in a framed closing whose light is held inside the box, with the
   footer unlit. A light middle section was tried the same day and dropped
   (founders: "black is better").

   The comparison is one table from md up, its plan header stuck under the
   navbar (68px), which needs no overflow on its ancestors. A phone shows one
   plan at a time beside the labels, picked in a bar stuck under the navbar
   (site-wide pass, 2026-11-15: the sideways-scrolling table hid two of the
   three plans), so the page never scrolls sideways.

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
        { text: 'Restore points kept for 30 days' },
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
        // Every plan lists every published version and restores from History; how
        // far back a restore reaches is the row above. The Plan rows' rollback and
        // history fields gate only APIs the console no longer calls.
        { label: 'Deployment history and rollback', cells: ['Full history', 'Full history', 'Full history'] },
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
    a: 'No. They are included on every plan. Paid plans raise capacity, keep restore points longer, and add support and advanced controls.',
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
            <div className="overflow-hidden rounded-[10px] border border-white/[0.10] bg-[#0b0c0f]">
              <header className="relative isolate overflow-hidden border-b border-white/[0.08] px-[20px] pb-[40px] pt-[44px] text-center md:pb-[48px] md:pt-[60px]">
                {/* The landing's painted light, at well under half strength (founders: less violet), faded out before the plans. */}
                <Light art="b" reach={420} strength={0.4} mask="linear-gradient(to bottom, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.55) 50%, transparent 100%)" />
                <h1 id="pricing-title" className={`hero-enter text-[44px] text-white md:text-[56px] ${DISPLAY}`}>
                  Pricing
                </h1>
                <p className={`hero-enter hero-enter-1 mx-auto mt-[14px] max-w-[54ch] text-[17px] text-zinc-300 [text-wrap:balance] md:text-[18px] ${LEDE}`}>
                  Start free. You pay for capacity; self-healing is on every plan and never metered.
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

        {/* The four billing facts that hold on every plan (checked against this page's own FAQ and lib/pricing/catalog.ts), under a quiet light. */}
        <Box id="billing-title" light={{ art: 'c', flip: true, strength: 0.4 }}>
          <BoxHead
            id="billing-title"
            layout="stacked"
            tag={{ icon: Receipt, label: 'Billing' }}
            title="How billing works"
            body="What you pay for, and what you never pay for, on every plan."
          />
          <Cells
            items={[
              { icon: HeartPulse, title: 'Self-healing is never metered', body: 'The same check every minute on every plan, Free included, with no cap and no credits spent.' },
              {
                icon: ShieldCheck,
                title: 'No surprise bills',
                body: published
                  ? 'Every quota is a hard cap unless you set a spend limit, paid in advance.'
                  : 'Every quota is a hard cap. Nothing is billed past what your plan includes.',
              },
              { icon: Bot, title: 'Your agent’s tools are free', body: 'The typed MCP tools compile straight to SQL with no model call, so they never use AI credits.' },
              { icon: Github, title: 'Self-host for free', body: 'Apache-2.0. The same code on your own servers; pg_dump moves your data either way.', href: ROUTES.github, link: 'View on GitHub' },
            ]}
          />
        </Box>

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

        <CloseBox
          id="pricing-close"
          title="Start with one free project"
          lede="No credit card. Move to Pro when your product needs more capacity."
        >
          <StartButton />
        </CloseBox>
      </Page>
    </SiteShell>
  )
}

/* ── Plans ───────────────────────────────────────────────────────────────── */

const CADENCES: { id: Cadence; label: string; note?: string }[] = [
  { id: 'monthly', label: 'Monthly' },
  { id: 'yearly', label: 'Yearly', note: '20% off' },
]

function CadenceSwitch({ value, onChange }: { value: Cadence; onChange: (next: Cadence) => void }) {
  return <Segmented label="Billing period" options={CADENCES} value={value} onChange={onChange} />
}

/**
 * A segmented control: a radio group with a roving tab stop. Tab reaches the
 * selected option, the arrow keys move between them.
 */
function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  full = false,
}: {
  label: string
  options: { id: T; label: string; note?: string }[]
  value: T
  onChange: (next: T) => void
  /** Fill the row, the options sharing it equally (the phone plan picker). */
  full?: boolean
}) {
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
      aria-label={label}
      className={`${full ? 'flex w-full' : 'inline-flex'} shrink-0 rounded-[8px] border border-white/[0.10] bg-white/[0.03] p-[3px]`}
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
            className={`inline-flex h-[34px] cursor-pointer items-center gap-[8px] rounded-[6px] px-[14px] text-[14px] font-medium tracking-[-0.006em] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${
              full ? 'flex-1 justify-center' : ''
            } ${selected ? 'bg-white/[0.10] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            {option.label}
            {option.note && <span className={`text-[13px] font-normal ${selected ? 'text-zinc-300' : 'text-faint'}`}>{option.note}</span>}
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
  const quiet = plan.highlighted ? 'text-zinc-300' : 'text-faint'

  return (
    <article
      aria-labelledby={`plan-${plan.name}`}
      className={`relative isolate flex min-w-0 flex-col overflow-hidden p-[24px] sm:p-[28px] md:p-[32px] ${
        divided ? 'border-t border-white/[0.08] lg:border-l lg:border-t-0' : ''
      } ${plan.highlighted ? 'bg-white/[0.03]' : ''}`}
    >
      {/* Pro is marked by a white top edge, a lighter surface and the word, never by colour alone, and by no violet light. */}
      {plan.highlighted && <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/70" />}
      <div className="flex min-h-[26px] items-center justify-between gap-[12px]">
        <h3 id={`plan-${plan.name}`} className={`text-[17px] text-white ${HEADING}`}>
          {plan.name}
        </h3>
        {plan.highlighted && <span className="text-[13px] text-zinc-300">Recommended</span>}
      </div>

      <p className="mt-[20px] flex flex-wrap items-baseline gap-x-[8px] gap-y-[4px]">
        <span className="text-[44px] font-normal leading-none tracking-[-0.035em] text-white tabular-nums">{price}</span>
        {plan.name === 'Pro' && yearly && (
          <s className={`text-[20px] tracking-[-0.02em] tabular-nums ${quiet}`}>
            <span className="sr-only">Month to month: </span>
            {PRO_MONTHLY}
          </s>
        )}
        {unit && <span className={`text-[15px] ${quiet}`}>{unit}</span>}
      </p>
      <p className={`mt-[10px] text-[13px] ${quiet}`} aria-live="polite">
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
              <Check aria-hidden className="mt-[3px] h-[15px] w-[15px] shrink-0 text-zinc-400" strokeWidth={2} />
              <span className="min-w-0 [text-wrap:pretty]">
                {item.text}
                {item.note && <span className="mt-[2px] block text-[13px] text-faint">{item.note}</span>}
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

type PlanName = 'Free' | 'Pro' | 'Enterprise'
type PlanHead = { name: PlanName; price: string; unit: string; cta: string }

const PLAN_PICKS: { id: PlanName; label: string }[] = [
  { id: 'Free', label: 'Free' },
  { id: 'Pro', label: 'Pro' },
  { id: 'Enterprise', label: 'Enterprise' },
]

const PLAN_BUTTON =
  'inline-flex h-[36px] cursor-pointer items-center justify-center rounded-[6px] px-[16px] text-[13px] font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70'
const PLAN_BUTTON_QUIET = `${PLAN_BUTTON} border border-white/[0.12] bg-white/[0.03] text-zinc-200 hover:border-white/25 hover:bg-white/[0.07] hover:text-white`

/** A plan's button, the same in the table and on a phone: Enterprise is an email, the others start checkout or sign-up. */
function PlanCta({ head, onCta, className = '' }: { head: PlanHead; onCta: () => void; className?: string }) {
  if (head.name === 'Enterprise') {
    return (
      <a href={ENTERPRISE_MAIL} className={`${PLAN_BUTTON_QUIET} ${className}`}>
        {head.cta}
      </a>
    )
  }
  return (
    <button
      type="button"
      onClick={onCta}
      className={`${head.name === 'Pro' ? `${PLAN_BUTTON} bg-white text-black hover:bg-zinc-200` : PLAN_BUTTON_QUIET} ${className}`}
    >
      {head.cta}
    </button>
  )
}

function ComparisonSection({ published, cadence, onCta }: { published: boolean; cadence: Cadence; onCta: () => void }) {
  const groups = comparisonGroups(published)
  const [pick, setPick] = useState<PlanName>('Pro')
  const yearly = cadence === 'yearly'
  const heads: PlanHead[] = [
    { name: 'Free', price: '$0', unit: '/month', cta: 'Start free' },
    {
      name: 'Pro',
      price: yearly ? PRO_YEARLY_MONTHLY : PRO_MONTHLY,
      unit: yearly ? '/month, billed yearly' : '/month',
      cta: 'Get Pro',
    },
    { name: 'Enterprise', price: 'Custom', unit: 'annual', cta: 'Talk to us' },
  ]
  const shown = heads.findIndex((head) => head.name === pick)
  const shownHead = heads[shown]

  return (
    <Section id="compare" aria-labelledby="compare-title" className="scroll-mt-[72px]">
      <SectionHead
        id="compare-title"
        title="Every limit, side by side"
        lede={
          published
            ? 'Pro’s quotas are shared by every project on your account. Past a quota, nothing is billed unless you set a spend limit and pay it in advance. Usage then continues at the rates shown, never past that limit.'
            : (
                <>
                  Enterprise adds custom limits, single <span className="whitespace-nowrap">sign-on</span>, onboarding and migration
                  help, and a <span className="whitespace-nowrap">12-hour</span> SLA.
                </>
              )
        }
      />

      {/* Phones: one plan beside the labels, chosen in a bar that stays under the navbar while the list scrolls. */}
      <div className="mt-[40px] md:hidden">
        <div className="sticky top-[68px] z-10 -mx-5 bg-[#08090a] px-5 py-[10px] sm:-mx-6 sm:px-6">
          <Segmented<PlanName> label="Plan to compare" options={PLAN_PICKS} value={pick} onChange={setPick} full />
        </div>
        <div className="mt-[20px] flex items-center justify-between gap-[16px]">
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-[6px]">
            <span className="text-[22px] font-medium tracking-[-0.02em] text-white tabular-nums">{shownHead.price}</span>
            <span className="text-[13px] text-faint">{shownHead.unit}</span>
          </p>
          <PlanCta head={shownHead} onCta={onCta} className="shrink-0" />
        </div>
        {groups.map((group) => (
          <div key={group.title} className="mt-[32px]">
            <h3>
              <GroupTitle group={group} />
            </h3>
            <dl className="mt-[12px]">
              {group.rows.map((row) => (
                <div key={row.label} className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-x-[16px] border-t border-white/[0.06] py-[14px]">
                  <dt>
                    <p className="text-[14px] font-medium leading-[1.5] text-zinc-200">{row.label}</p>
                    {row.hint && <p className="mt-[4px] text-[13px] leading-[1.5] text-faint">{row.hint}</p>}
                  </dt>
                  <dd className="text-[14px] leading-[1.5]">
                    <CellView cell={row.cells[shown]} />
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>

      <div className="mt-[64px] hidden rounded-[10px] border border-white/[0.10] md:block">
        <table className="w-full table-fixed border-separate border-spacing-0 text-left">
          <caption className="sr-only">Backenly plans compared, feature by feature</caption>
          <colgroup>
            <col className="w-[31%]" />
            <col />
            <col className="bg-white/[0.022]" />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th
                className={`${STUCK} sticky top-[68px] z-10 rounded-tl-[10px] border-b border-white/[0.08] px-[24px] py-[20px] align-bottom`}
              >
                <span className="sr-only">Feature</span>
              </th>
              {heads.map((head, i) => (
                <th
                  key={head.name}
                  scope="col"
                  className={`sticky top-[68px] z-10 border-b border-white/[0.08] px-[16px] py-[20px] align-top font-normal lg:px-[24px] ${
                    head.name === 'Pro' ? 'bg-[#0d0e0f]' : STUCK
                  } ${i === heads.length - 1 ? 'rounded-tr-[10px]' : ''}`}
                >
                  <p className="text-[15px] font-medium text-white">{head.name}</p>
                  <p className="mt-[4px] flex flex-wrap items-baseline gap-x-[6px]">
                    <span className="text-[20px] font-medium tracking-[-0.02em] text-white tabular-nums">{head.price}</span>
                    <span className="text-[13px] text-faint">{head.unit}</span>
                  </p>
                  <PlanCta head={head} onCta={onCta} className="mt-[14px] w-full" />
                </th>
              ))}
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.title}>
              <tr>
                <th colSpan={4} scope="colgroup" className="px-[24px] pb-[12px] pt-[36px] text-left font-normal">
                  <GroupTitle group={group} />
                </th>
              </tr>
              {group.rows.map((row) => (
                <tr key={row.label}>
                  <th
                    scope="row"
                    className="border-t border-white/[0.06] px-[24px] py-[14px] align-top font-normal"
                  >
                    <p className="text-[14px] font-medium leading-[1.5] text-zinc-200">{row.label}</p>
                    {row.hint && <p className="mt-[4px] text-[13px] leading-[1.5] text-faint">{row.hint}</p>}
                  </th>
                  {row.cells.map((cell, i) => (
                    <td key={heads[i].name} className="border-t border-white/[0.06] px-[16px] py-[14px] align-top text-[14px] leading-[1.5] lg:px-[24px]">
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
    <span className="flex w-max items-center gap-[10px]">
      <GroupIcon aria-hidden className="h-4 w-4 text-zinc-400" strokeWidth={1.75} />
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
        <Minus aria-hidden className="h-4 w-4 text-zinc-500" strokeWidth={2} />
        <span className="sr-only">Not included</span>
      </span>
    )
  }
  if (typeof cell === 'string') return <p className="text-zinc-300">{cell}</p>
  return (
    <div>
      <p className="text-zinc-200">{cell.value}</p>
      {cell.then && <p className="mt-[4px] text-[13px] leading-[1.5] text-faint">{cell.then}</p>}
    </div>
  )
}
