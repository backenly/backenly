import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight, BadgeCheck, ListChecks, Shield, Timer } from 'lucide-react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { SiteShell } from '@/components/site/SiteShell'
import { ButtonLink, Facts, HorizonClose, JsonLd, Page, PageHero, Section, SectionHead } from '@/components/site/kit'
import { Faq } from '@/components/site/Faq'
import { Reveal } from '@/components/site/Reveal'
import { StartButton } from '@/components/site/StartButton'
import { TITLE } from '@/components/site/tokens'
import { USE_CASE_LIST } from './data'

const APP_URL = 'https://backenly.com'

export const metadata: Metadata = {
  title: 'Use Cases: Five workflows Backenly is built for',
  description:
    "Driving a backend from a coding agent over MCP, adopting a backend your AI tools generated, moving a supabase-js frontend, running an AI product's data layer, and multi-tenant SaaS isolation. Each with what Backenly does, what stays yours, and where it stops.",
  keywords: [
    'MCP backend for coding agents',
    'supabase migration',
    'multi-tenant SaaS row level security',
    'AI product backend',
    'autonomous backend platform',
  ],
  openGraph: {
    title: 'Backenly Use Cases',
    description:
      'Five workflows, each with the problem, the mechanism, the division of labour, and the known limitations.',
    url: `${APP_URL}/use-cases`,
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Backenly Use Cases',
    description: 'Five workflows, with what Backenly does and what stays yours.',
  },
  alternates: { canonical: `${APP_URL}/use-cases` },
}

/**
 * FAQ answers here are the boundary questions: what it does not do, and who
 * should not use it. A FAQ whose answers all say yes is not answering anything.
 */
const FAQ = [
  {
    q: 'What does Backenly actually replace?',
    a: 'The backend operator. Your coding agent still writes the frontend and the integration code; you still make the product decisions. What the platform takes over is designing and applying schema change safely, enforcing authorization in the database, proving it works after each change, and monitoring and repairing the running backend afterwards.',
  },
  {
    q: 'How is this different from asking my agent to generate backend code?',
    a: 'An agent can write backend code well. What it cannot do is persist: the session ends and its model of your schema ends with it, and it is not watching when error rates move at 2 a.m. It also has no structural limit; nothing stops a bad turn from dropping a table. Backenly keeps the schema, the change ledger and the verification evidence, and destructive operations are absent from the agent-facing surface entirely.',
  },
  {
    q: 'When is Backenly the wrong choice?',
    a: 'When the backend is the product: a database engine, a system with microsecond latency budgets, or one whose regulation requires owning every line. Also when your team wants to own infrastructure: structure mutates only through governed actions, there is no raw-SQL path for changing it, and Backenly exposes no SQL functions, so there is no rpc() surface.',
  },
  {
    q: 'Do I have to build through an agent?',
    a: 'For creating backend resources, yes. MCP is the build door and there is no in-product chat builder. The dashboard is where you inspect, approve and operate. Everything else is standard: the runtime is REST over PostgREST, and you can take a direct PostgreSQL connection string for psql, an ORM or a BI tool.',
  },
]

const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQ.map((item) => ({
    '@type': 'Question',
    name: item.q,
    acceptedAnswer: { '@type': 'Answer', text: item.a },
  })),
}

/** The through-line, stated once here rather than repeated on every use case. */
const SHARED = [
  {
    icon: <ListChecks aria-hidden className="h-5 w-5" strokeWidth={1.75} />,
    title: 'One governed path for every change',
    body: 'Whether a change comes from you, your agent or an automated repair, it goes through the same typed kernel: validated, audited and applied all-or-nothing. There is deliberately no raw-SQL route around it.',
  },
  {
    icon: <Shield aria-hidden className="h-5 w-5" strokeWidth={1.75} />,
    title: 'Authorization the database enforces',
    body: 'Each project has its own PostgreSQL schema, and row access is decided by row-level security rather than by application filtering. A rule you cannot forget on one screen.',
  },
  {
    icon: <BadgeCheck aria-hidden className="h-5 w-5" strokeWidth={1.75} />,
    title: 'Evidence instead of success messages',
    body: 'After a build, checks run against the live runtime over real HTTP, including signing in as a second user to confirm isolation holds. Checks that cannot run report as skipped, never as passed.',
  },
  {
    icon: <Timer aria-hidden className="h-5 w-5" strokeWidth={1.75} />,
    title: 'A loop that keeps going after you stop',
    body: 'One-minute cadence on every plan, applying only reversible, snapshotted changes on its own. Auth, credentials and anything destructive wait for a human at every autonomy level.',
  },
]

/* ─────────────────────────────────────────────────────────────
   /use-cases: the workflow index.

   Each use case is a row, not a card: who it is for, the promise, and then the
   one thing that makes these pages worth reading, the actual sequence Backenly
   runs, drawn as a rail of its verbs (Connect, Read, Write...). The trade-off
   is on the row too, so the boundary is visible before the click.
───────────────────────────────────────────────────────────── */

export default function UseCasesPage() {
  return (
    <SiteShell>
      <JsonLd json={safeJsonLd(faqSchema)} />
      <Page>
        <PageHero
          trail={[{ label: 'Home', href: '/' }, { label: 'Use cases' }]}
          title="Five workflows, and where each one stops"
          lede="Each names the problem, the sequence Backenly actually runs, what stays yours, and its known limits. A use case that cannot say where it stops is a brochure."
          actions={
            <>
              <StartButton />
              <ButtonLink href="/resources" variant="secondary">
                Read the docs
              </ButtonLink>
            </>
          }
        />

        <Section flush aria-label="Use cases">
          <ul>
            {USE_CASE_LIST.map((uc, index) => (
              <Reveal as="li" key={uc.slug} delay={index === 0 ? 0 : 0.04}>
                <Link
                  href={`/use-cases/${uc.slug}`}
                  className={`group grid gap-8 py-10 transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300 md:py-14 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16 ${
                    index === 0 ? '' : 'border-t border-white/[0.08]'
                  }`}
                >
                  <div className="min-w-0">
                    <p className="text-[14px] text-zinc-500">{uc.who}</p>
                    <h2
                      className={`mt-3 max-w-[22ch] text-[26px] text-white [text-wrap:balance] transition-colors duration-200 md:text-[34px] ${TITLE}`}
                    >
                      {uc.headline}
                    </h2>
                  </div>
                  <div className="min-w-0 lg:pt-8">
                    <p className="max-w-[62ch] text-[16px] leading-[1.7] text-zinc-400 [text-wrap:pretty] md:text-[17px]">
                      {uc.subheadline}
                    </p>

                    {/* Each connector leads its step and the list hangs 28px (one
                        connector) outside a clipping box, so whichever step starts
                        a row loses its connector and a wrap never leaves a dangling
                        line at a row's end. */}
                    <div className="mt-7 overflow-hidden">
                      <ol aria-label="The sequence Backenly runs" className="-ml-7 flex flex-wrap items-center gap-y-2">
                        {uc.workflow.map((step) => (
                          <li key={step.label} className="flex items-center">
                            <span aria-hidden className="mx-1.5 h-px w-4 bg-white/[0.16]" />
                            <span className="rounded-md border border-white/[0.10] bg-white/[0.03] px-2.5 py-1 text-[13px] text-zinc-300 transition-colors duration-300 group-hover:border-violet-300/25">
                              {step.label}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>

                    <p className="mt-7 max-w-[62ch] text-[14px] leading-[1.65] text-zinc-400 [text-wrap:pretty]">
                      <span className="text-zinc-200">Where it stops. </span>
                      {uc.limitations[0]}
                    </p>

                    <span className="mt-7 inline-flex items-center gap-1.5 text-[15px] font-medium text-zinc-300 transition-colors duration-200 group-hover:text-white">
                      Read the workflow
                      <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                    </span>
                  </div>
                </Link>
              </Reveal>
            ))}
          </ul>
        </Section>

        <Section aria-labelledby="common-ground">
          <Reveal>
            <SectionHead
              id="common-ground"
              title="What holds across all five"
              lede="The workflows differ. These four properties do not, and they are why the workflows are possible."
            />
          </Reveal>
          <Reveal delay={0.06}>
            <Facts className="mt-14" items={SHARED} />
          </Reveal>
        </Section>

        <Section aria-labelledby="use-case-faq">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-16">
            <Reveal className="lg:sticky lg:top-28 lg:self-start">
              <SectionHead id="use-case-faq" title="Before you pick one" />
            </Reveal>
            <Reveal delay={0.06}>
              <Faq items={FAQ} />
            </Reveal>
          </div>
        </Section>

        <HorizonClose
          title="One free project, no credit card"
          lede="Connect your agent, build something small, and read the verification evidence yourself."
        >
          <StartButton />
          <ButtonLink href="/comparisons" variant="secondary">
            See comparisons
          </ButtonLink>
        </HorizonClose>
      </Page>
    </SiteShell>
  )
}
