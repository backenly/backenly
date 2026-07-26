import { Metadata } from 'next'
import { safeJsonLd } from "@/lib/security/safe-jsonld"
import { BrainCircuit, Rocket, Sprout, UsersRound, Zap, type LucideIcon } from 'lucide-react'
import { SiteShell } from '@/components/site/SiteShell'
import {
  Card,
  IconTile,
  InlineArrow,
  PageHero,
  PrimaryButton,
  Section,
  SectionIntro,
  SectionHeading,
  Lead,
  LinkCard,
  FaqList,
  CtaSection,
} from '@/components/site/kit'

export const metadata: Metadata = {
  title: 'Use Cases — Who Backenly Is For',
  description:
    'Backenly is the autonomous backend for teams shipping with coding agents: startup MVPs, AI apps, founders with real users, and ambitious side projects. See how each ships a production backend that runs itself.',
  keywords: [
    'AI backend use cases',
    'backend for coding agents',
    'startup MVP backend',
    'AI app backend',
    'autonomous backend platform',
    'backend for founders with real users',
  ],
  openGraph: {
    title: 'Backenly Use Cases — Who Is It For?',
    description:
      'Founders, AI app builders, and developers running coding agents use Backenly to ship production backends that plan, apply, verify, and heal themselves.',
    url: 'https://backenly.com/use-cases',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Backenly Use Cases — Who Is It For?',
    description: 'How founders, AI builders, and agent-driven developers ship self-running backends with Backenly.',
  },
  alternates: { canonical: 'https://backenly.com/use-cases' },
}

const useCases = [
  {
    slug: 'startup-mvps',
    label: 'Startup MVPs',
    headline: 'Ship the MVP, keep it running',
    description:
      'Stop burning runway on backend boilerplate. Backenly stands up a production-grade backend from a description, then operates it while you focus on the product and the market.',
    shortDescription:
      'Move runway into product learning instead of schema setup, auth wiring, API routes, and deploy chores — with monitoring, rollback, and an audit trail from day one.',
    icon: Rocket,
  },
  {
    slug: 'ai-app-builders',
    label: 'AI App Builders',
    headline: 'Give AI features a real backend',
    description:
      'AI products accumulate infrastructure fast — data, auth, vector search, event pipelines, streaming. Backenly runs all of it under one governed runtime so your best hours go to the model layer.',
    shortDescription:
      'Store users, prompts, files, jobs, outputs, and app state behind one runtime — with pgvector RAG, event functions, and realtime built in.',
    icon: BrainCircuit,
  },
  {
    slug: 'founders',
    label: 'Founders with Real Users',
    headline: 'Run production without a backend team',
    description:
      'You shipped fast with AI tools and real users showed up. Backenly puts a real, operated backend under the product — monitoring, safe fixes, approval queues, and rollback — so production is not your second job.',
    shortDescription:
      'Put an operated backend under the product you shipped with AI tools — monitoring, safe repairs, approvals, and restore points, without a backend hire.',
    icon: UsersRound,
  },
  {
    slug: 'ai-assisted-developers',
    label: 'AI-Assisted Developers',
    headline: 'Point your agent at a real backend',
    description:
      'Connect Claude Code or Cursor over MCP and let your agent read the live schema and drive tables, APIs, auth, and storage — through governed changes it cannot break, with a receipt for each one.',
    shortDescription:
      'Give your coding agent full backend reach over MCP, with structural guardrails: governed writes, human approval on destructive operations, and a change history.',
    icon: Zap,
  },
  {
    slug: 'side-projects',
    label: 'Side Projects',
    headline: 'A real backend, free forever',
    description:
      'One permanently free project, no credit card. Backenly gives your side project a real backend — not a toy — and a self-healing loop that runs every minute so it is still running when someone finds it months later.',
    shortDescription:
      'Use one permanent free project to launch a serious side project without infrastructure spend — and without maintenance being the reason it dies.',
    icon: Sprout,
  },
] satisfies {
  slug: string
  label: string
  headline: string
  description: string
  shortDescription: string
  icon: LucideIcon
}[]

const operatingProof = [
  'Generated PostgreSQL schema and REST APIs',
  'Project-scoped auth, storage, and realtime',
  'Health checks, rollback, and audit history',
  'Clear SDK contract for any frontend',
]

const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'Who is Backenly for?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Backenly is for founders shipping products with real users, teams building AI apps, startups shipping MVPs under real load, and developers who drive their backend from a coding agent over MCP. It suits anyone who needs a production backend without running the infrastructure themselves.',
      },
    },
    {
      '@type': 'Question',
      name: 'How do coding agents work with Backenly?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Backenly ships an MCP server. One command connects Claude Code, Cursor, Codex, or Cline, and your agent reads the live schema and applies governed changes to tables, APIs, auth, and storage — with destructive operations blocked at the key scope and routed to human approval.',
      },
    },
    {
      '@type': 'Question',
      name: 'What kind of apps can I build with Backenly?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'You can build any app that needs a backend: SaaS products, marketplaces, mobile apps, AI-powered apps, internal tools, MVPs, and side projects.',
      },
    },
    {
      '@type': 'Question',
      name: 'Is Backenly suitable for production apps?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Yes. Backenly generates production-ready PostgreSQL databases, REST APIs with proper auth and row-level security, file storage, and realtime subscriptions. It is designed for real products, not prototypes.',
      },
    },
  ],
}

export default function UseCasesPage() {
  return (
    <SiteShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(faqSchema) }}
      />
      <main className="relative z-20">
        <PageHero
          align="center"
          eyebrow="Use Cases"
          title="Built for teams with something to run"
          subtitle="Backenly is the autonomous backend for people shipping real products — your coding agent drives it over MCP, your app builder pairs with it, your team ships an MVP under real load. It plans, applies, verifies, and heals the backend, so operating it isn’t your job."
          actions={
            <PrimaryButton href="/auth/signup">
              Start building free
              <InlineArrow />
            </PrimaryButton>
          }
          proof={[
            { label: 'Founders', value: 'A backend that runs itself' },
            { label: 'AI apps', value: 'Data, auth, RAG, realtime' },
            { label: 'Agent devs', value: 'Governed MCP access' },
          ]}
        />

        {/* Use Case Cards */}
        <Section aria-label="Use cases" width="wide" className="!pt-0">
          <div className="grid gap-6 sm:grid-cols-2">
            {useCases.map((uc) => {
              const Icon = uc.icon
              return (
              <LinkCard key={uc.slug} href={`/use-cases/${uc.slug}`}>
                <IconTile size={48}>
                  <Icon size={22} className="text-zinc-200" strokeWidth={1.75} />
                </IconTile>
                <h2 className="text-lg font-normal text-white tracking-tight mb-1">{uc.label}</h2>
                <p className="text-sm font-normal text-violet-300 mb-3">{uc.headline}</p>
                <p className="text-sm text-neutral-400 font-extralight leading-relaxed flex-1">
                  {uc.shortDescription}
                </p>
                <p className="mt-5 text-sm font-semibold text-zinc-200 group-hover:text-white transition-colors">
                  Learn more
                </p>
              </LinkCard>
              )
            })}
          </div>
        </Section>

        {/* What is Backenly — GEO / AI search section */}
        <Section aria-label="Shared runtime" width="wide">
          <div className="grid gap-8 lg:grid-cols-[0.95fr_1.05fr] lg:items-start">
            <SectionIntro
              eyebrow="Shared foundation"
              title="Different builders, same serious backend"
              body="Each use case starts from a different workflow, but the outcome is consistent: an inspectable backend with real runtime boundaries."
            />
            <Card>
              <div className="grid gap-4 sm:grid-cols-2">
                {operatingProof.map((item) => (
                  <div key={item} className="flex gap-3 text-sm leading-6 text-zinc-400">
                    <span aria-hidden className="mt-2.5 h-1 w-1 shrink-0 rounded-full bg-zinc-600" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </Section>

        <Section aria-label="About Backenly" width="prose">
          <SectionHeading className="mb-4">What is Backenly?</SectionHeading>
          <Lead className="mb-4">
            Backenly is an autonomous backend platform that turns product descriptions into running
            backend infrastructure. It plans the backend, applies the infrastructure, verifies the
            runtime, and keeps every change reviewable and reversible — database tables, REST APIs,
            user authentication, file storage, and realtime subscriptions, ready to use immediately.
          </Lead>
          <Lead>
            There is no backend code to write, no infrastructure to configure, and no DevOps
            required. Backenly does not just generate resources — it manages backend change safely,
            so you can focus on building your product.
          </Lead>

          <h3 className="text-lg font-normal text-white mt-8 mb-3">
            What problem does Backenly solve?
          </h3>
          <Lead>
            Building a backend from scratch takes weeks. You need to design a database schema, write
            API endpoints, implement authentication, handle file storage, and set up monitoring —
            before writing a single line of product logic. Backenly eliminates this by doing it all
            automatically, in minutes, from a plain English description.
          </Lead>

          <h3 className="text-lg font-normal text-white mt-8 mb-3">
            What makes Backenly different from other backend tools?
          </h3>
          <Lead>
            Most backend tools require you to configure tables, write API code, and manage
            deployments manually. Backenly is autonomous from the ground up — you describe what you
            want and it plans, applies, and verifies the rest. It is not a drag-and-drop builder, and
            it is not a code generator. It is an autonomous backend platform that understands intent
            and manages every change safely.
          </Lead>
        </Section>

        {/* FAQ */}
        <Section aria-label="Frequently asked questions" width="prose">
          <SectionHeading className="mb-8">Frequently asked questions</SectionHeading>
          <FaqList
            items={faqSchema.mainEntity.map((item) => ({
              q: item.name,
              a: item.acceptedAnswer.text,
            }))}
          />
        </Section>

        <CtaSection
          title="Ready to ship your backend?"
          body="One free project, no credit card required. Start in minutes."
        >
          <PrimaryButton href="/auth/signup">Get started free</PrimaryButton>
        </CtaSection>
      </main>
    </SiteShell>
  )
}
