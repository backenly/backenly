import { Metadata } from 'next'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { SiteShell } from '@/components/site/SiteShell'
import { useCaseCards } from './data'
import {
  InlineArrow,
  PageHero,
  PrimaryButton,
  SecondaryButton,
  Section,
  SectionIntro,
  SectionHeading,
  LinkCard,
  FaqList,
  CtaSection,
} from '@/components/site/kit'

const APP_URL = 'https://backenly.com'

export const metadata: Metadata = {
  title: 'Use Cases — Five workflows Backenly is built for',
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
 * FAQ answers here are the boundary questions — what it does not do, and who
 * should not use it. A FAQ whose answers all say yes is not answering anything.
 */
const FAQ = [
  {
    q: 'What does Backenly actually replace?',
    a: 'The backend operator. Your coding agent still writes the frontend and the integration code; you still make the product decisions. What the platform takes over is designing and applying schema change safely, enforcing authorization in the database, proving it works after each change, and monitoring and repairing the running backend afterwards.',
  },
  {
    q: 'How is this different from asking my agent to generate backend code?',
    a: 'An agent can write backend code well. What it cannot do is persist: the session ends and its model of your schema ends with it, and it is not watching when error rates move at 2 a.m. It also has no structural limit — nothing stops a bad turn from dropping a table. Backenly keeps the schema, the change ledger, and the verification evidence, and destructive operations are absent from the agent-facing surface entirely.',
  },
  {
    q: 'When is Backenly the wrong choice?',
    a: 'When the backend is the product — a database engine, a system with microsecond latency budgets, or one whose regulation requires owning every line. Also when your team wants to own infrastructure: structure mutates only through governed actions, there is no raw-SQL path for changing it, and Backenly exposes no SQL functions, so there is no rpc() surface.',
  },
  {
    q: 'Do I have to build through an agent?',
    a: 'For creating backend resources, yes — MCP is the build door and there is no in-product chat builder. The dashboard is where you inspect, approve, and operate. Everything else is standard: the runtime is REST over PostgREST, and you can take a direct PostgreSQL connection string for psql, an ORM, or a BI tool.',
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
    title: 'One governed path for every change',
    body: 'Whether a change comes from you, your agent, or an automated repair, it goes through the same typed kernel — validated, audited, and applied all-or-nothing. There is deliberately no raw-SQL route around it.',
  },
  {
    title: 'Authorization the database enforces',
    body: 'Each project has its own PostgreSQL schema, and row access is decided by row-level security rather than by application filtering. A rule you cannot forget on one screen.',
  },
  {
    title: 'Evidence instead of success messages',
    body: 'After a build, checks run against the live runtime over real HTTP — including signing in as a second user to confirm isolation holds — and each returns its assertions. Checks that cannot run report as skipped, never as passed.',
  },
  {
    title: 'A loop that keeps going after you stop',
    body: 'One-minute cadence on every plan, applying only reversible snapshotted changes on its own. Auth, credentials, and anything destructive wait for a human at every autonomy level.',
  },
]

export default function UseCasesPage() {
  return (
    <SiteShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(faqSchema) }}
      />
      <main className="relative z-20">
        <PageHero
          eyebrow="Use Cases"
          title="Five workflows, and where each one stops"
          subtitle="Each page below states the problem, what you would normally build, the sequence Backenly actually runs, what stays your responsibility, and the known limitations. If a page cannot name what it does not do, it is not a use case — it is a brochure."
          actions={
            <>
              <PrimaryButton href="/auth/signup">
                Start free
                <InlineArrow />
              </PrimaryButton>
              <SecondaryButton href="/resources">Read the docs</SecondaryButton>
            </>
          }
        />

        <Section aria-label="Use cases" width="wide-prose" className="!pt-0">
          <div className="grid gap-5 md:grid-cols-2">
            {useCaseCards.map((uc) => (
              <LinkCard key={uc.slug} href={`/use-cases/${uc.slug}`}>
                <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500">
                  {uc.who}
                </p>
                <h2 className="mt-3 text-lg font-semibold leading-tight tracking-tight text-white">
                  {uc.headline}
                </h2>
                <p className="mt-3 flex-1 text-sm font-light leading-relaxed text-neutral-400">
                  {uc.summary}
                </p>
                <p className="mt-5 border-t border-white/[0.07] pt-4 text-xs font-light leading-6 text-neutral-500">
                  <span className="font-medium text-neutral-400">Trade-off: </span>
                  {uc.firstLimitation}
                </p>
                <p className="mt-4 text-sm font-semibold text-zinc-200 transition-colors group-hover:text-white">
                  Read the workflow
                </p>
              </LinkCard>
            ))}
          </div>
        </Section>

        <Section aria-label="What every use case shares" width="wide-prose">
          <SectionIntro
            eyebrow="Common ground"
            title="What holds across all five"
            body="The workflows differ. These four properties do not, and they are the reason the workflows are possible."
          />
          <div className="grid gap-5 md:grid-cols-2">
            {SHARED.map((item) => (
              <div
                key={item.title}
                className="rounded-lg border border-white/10 bg-white/[0.02] p-6"
              >
                <h3 className="text-base font-medium text-white">{item.title}</h3>
                <p className="mt-2.5 text-sm font-light leading-relaxed text-neutral-400">
                  {item.body}
                </p>
              </div>
            ))}
          </div>
        </Section>

        <Section aria-label="Frequently asked questions" width="prose">
          <SectionHeading className="mb-8">Before you pick one</SectionHeading>
          <FaqList items={FAQ} />
        </Section>

        <CtaSection
          title="One free project, no credit card"
          body="Connect your agent, build something small, and read the verification evidence."
        >
          <PrimaryButton href="/auth/signup">Start free</PrimaryButton>
        </CtaSection>
      </main>
    </SiteShell>
  )
}
