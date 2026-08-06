import { Metadata } from 'next'
import { safeJsonLd } from "@/lib/security/safe-jsonld"
import { notFound } from 'next/navigation'
import { SiteShell } from '@/components/site/SiteShell'
import {
  Breadcrumb,
  InlineArrow,
  PageHero,
  PrimaryButton,
  SecondaryButton,
  Section,
  SectionHeading,
  Lead,
  Card,
  FaqList,
  CtaSection,
  ChipRow,
  ChipLink,
} from '@/components/site/kit'

const APP_URL = 'https://backenly.com'

type UseCaseData = {
  slug: string
  label: string
  metaTitle: string
  metaDescription: string
  headline: string
  subheadline: string
  problem: string
  solution: string
  benefits: { title: string; body: string }[]
  /** The operations story after launch, tailored to this audience. */
  afterLaunch: { heading: string; body: string }[]
  faq: { q: string; a: string }[]
}

const USE_CASES: Record<string, UseCaseData> = {
  'ai-assisted-developers': {
    slug: 'ai-assisted-developers',
    label: 'AI-Assisted Developers',
    metaTitle: 'Backenly for Developers Using AI Coding Agents',
    metaDescription:
      'Point Claude Code, Cursor, or Codex at a real backend over MCP. Backenly gives your coding agent governed access to PostgreSQL, REST APIs, auth, and storage — every change reviewable and reversible.',
    headline: 'Point your agent at a real backend',
    subheadline:
      'You build with AI coding agents and move fast. Your backend should move with you — and keep running after the session ends.',
    problem:
      'An AI coding agent can scaffold a backend in one session — but the moment the session ends, so does everything the agent knew about it. You are left owning schema, migrations, auth, and deploys the agent wrote and will not remember. Momentum quietly turns into maintenance.',
    solution:
      'Connect Backenly over MCP and your agent drives a real, persistent backend: it reads the live schema and applies governed changes to tables, APIs, auth, storage, and realtime — changes it cannot break, each with a receipt in your project history. The backend outlives the session, and so does the record of every change.',
    benefits: [
      {
        title: 'Your agent, connected over MCP',
        body: 'One command connects Claude Code, Cursor, or Codex. Your agent reads the live schema and drives the backend through 60+ governed tools — no copy-pasting API docs, no hand-written migrations.',
      },
      {
        title: 'Built-in authentication',
        body: 'User sign-up, sign-in, JWT tokens, and session management are included. No auth library to configure or maintain.',
      },
      {
        title: 'Realtime out of the box',
        body: 'Subscribe to database changes and broadcast events with zero infrastructure. Backenly handles PostgreSQL LISTEN/NOTIFY and SSE streaming automatically.',
      },
      {
        title: 'JavaScript SDK included',
        body: 'Connect your frontend in minutes with the BackenlyClient SDK. Works with any JavaScript framework — React, Vue, Next.js, Svelte, or plain JS.',
      },
    ],
    afterLaunch: [
      {
        heading: 'Your agent forgets. The backend remembers.',
        body: "The structural weakness of agent-driven development is that your agent's memory ends with the session. Backenly is the stateful half of the workflow: the schema, every change ever applied, and why it was applied live in the project — inspectable in the dashboard, queryable by your agent over MCP. Add the Backenly MCP server (npx @backenly/mcp-server init) and Cursor or Claude Code reads your real tables and applies governed changes from inside the editor. Destructive operations are blocked at the MCP key scope, so a bad agent turn cannot drop a table — those route to the dashboard's approval flow, which shows live row counts before anything runs.",
      },
      {
        heading: 'Ship on Friday, sleep on Saturday',
        body: "After you deploy, the platform's autonomy loop watches real traffic — requests, latency, error rates — and reacts every minute, on every plan including Free. Safe fixes are applied and written up (what was detected, what changed, how the fix was verified); anything risky waits in a review queue for your approval. Every change carries a restore point. This is the difference between 'my agent built a backend' and 'my product has a backend': someone is on call, and it isn't you.",
      },
    ],
    faq: [
      {
        q: 'How does my coding agent connect to Backenly?',
        a: 'Over the Model Context Protocol (MCP). One command adds the Backenly MCP server to Claude Code, Cursor, Codex, or Cline, and your agent gets governed access to your backend — reading the live schema and applying changes it cannot break. You can also call the standard REST API and TypeScript SDK from any frontend.',
      },
      {
        q: 'Can I start without a credit card?',
        a: 'Yes. The free plan includes one permanent project with PostgreSQL, auth, realtime, and storage — no credit card required.',
      },
      {
        q: 'How fast can I get a backend running?',
        a: 'Most developers have a working backend in under 10 minutes. You connect your agent over MCP or describe what you need in plain English, and Backenly plans the change, applies it, and verifies the running result.',
      },
    ],
  },
  'founders': {
    slug: 'founders',
    label: 'Founders with Real Users',
    metaTitle: 'Backenly for Founders — Run Production Without a Backend Team',
    metaDescription:
      'You shipped the product with AI tools and real users showed up. Backenly operates the backend — monitoring, safe fixes, approval queues, and rollback — so production is not your second job.',
    headline: 'Your prototype graduated. Your backend should too.',
    subheadline:
      'You shipped fast with AI tools and real users showed up. Now the backend needs an operator — and it should not have to be you.',
    problem:
      'AI tools got you to a working product in record time. But the backend underneath — a builder\'s bundled backend or a pile of agent-generated code — has no one operating it. Real users mean real data, real error spikes, and real consequences, and every incident email lands on you. The thing that made you fast has quietly made you the on-call engineer.',
    solution:
      'Backenly puts a real, operated backend under your product: PostgreSQL, REST APIs, auth, and storage — with an autonomy loop that watches live traffic, applies fixes that are safe to apply, queues risky changes for your one-click approval, and keeps a restore point for every change. Your AI tools keep building; the platform keeps it running.',
    benefits: [
      {
        title: 'A real backend under your AI-built app',
        body: 'Your coding agent — Claude Code, Cursor, Codex — connects straight to Backenly over MCP, reads the live schema, and builds against real infrastructure instead of a throwaway backend.',
      },
      {
        title: 'Production-grade from day one',
        body: 'A real PostgreSQL database, REST APIs with JWT authentication, row-level security verified with live evidence, and file storage — the infrastructure answers investors and customers expect, without a backend hire.',
      },
      {
        title: 'Operated, not just hosted',
        body: 'Hosting keeps the server on. Backenly also does the operating: continuous monitoring of real traffic, anomaly detection, safe automated repairs, and a review queue for anything that needs your call.',
      },
      {
        title: 'Reversible by default',
        body: 'Destructive changes stop at an approval gate showing exactly how many live rows are affected. Every change carries a restore point, and the full history stays inspectable — a bad change is a rollback, not an outage.',
      },
    ],
    afterLaunch: [
      {
        heading: 'The part nobody warns you about: running it',
        body: "Every tool can give you a backend now. What no tool gave founders without a backend team is the person who runs it — the one who notices the error spike, applies the fix, and knows which change last Tuesday caused it. Backenly's autonomy loop is that person: it monitors your real traffic, detects degradations, applies fixes that are safe to apply, and sends anything risky to a review queue where it waits for your one-click approval. Every action is written up with what was detected, what was changed, and how it was verified — so you are never asked to trust a black box.",
      },
      {
        heading: 'You cannot break it by asking',
        body: "The fear that stops founders from touching a production backend is deleting something that matters. On Backenly that fear is structural, not behavioral: request something destructive — from the dashboard or through your agent — and the platform stops, shows you exactly how many live rows would be affected and whether the data is recoverable, and does nothing until you explicitly confirm. Every version of your backend is a restore point you can roll back to. When an engineer eventually joins, they inherit standard PostgreSQL and REST with a full change history — not a mystery.",
      },
    ],
    faq: [
      {
        q: 'Do I need a backend engineer to run Backenly?',
        a: 'No. The platform does the operating — monitoring, safe fixes, approval queues, and rollback. When you do hire an engineer, they inherit standard PostgreSQL and REST APIs with a complete change history, not a proprietary black box.',
      },
      {
        q: 'Can I keep building my frontend with AI tools?',
        a: 'Yes — that is the intended workflow. Your coding agent connects over MCP and reads the live schema; any other tool builds against the documented REST API and hosted SDK, so the frontend is wired to your real backend instead of a mock.',
      },
      {
        q: 'What happens when my product grows and needs more capacity?',
        a: 'You can upgrade your Backenly plan at any time. The platform scales with you — from the free plan to Pro ($25/month), with Enterprise above for custom limits and an SLA.',
      },
    ],
  },
  'startup-mvps': {
    slug: 'startup-mvps',
    label: 'Startup MVPs',
    metaTitle: 'Backenly for Startup MVPs — Ship Your MVP Without Backend Overhead',
    metaDescription:
      'Startups use Backenly to ship MVPs in days, not months. AI-generated backend infrastructure — databases, APIs, auth, storage — so your team focuses on the product, not the plumbing.',
    headline: 'Ship your MVP in days, not months',
    subheadline:
      'Every week spent building backend infrastructure is a week not spent learning from users. Backenly eliminates the backend bottleneck.',
    problem:
      'Building the backend of an MVP is slow, expensive, and risky. Your team spends weeks on database design, API development, auth systems, and deployment — before you have a single user. Runway burns. Market opportunities close.',
    solution:
      'Backenly generates your entire backend from a plain English description. In the time it would take to set up a database, Backenly has given you a complete backend: tables, APIs, auth, storage, realtime, and deployment.',
    benefits: [
      {
        title: 'From idea to working backend in minutes',
        body: 'Describe your MVP\'s data model and Backenly generates the complete backend. No schema design sessions, no API sprint, no auth setup — it is all done automatically.',
      },
      {
        title: 'Real infrastructure, not prototypes',
        body: 'Backenly generates production-grade PostgreSQL, proper REST APIs with JWT authentication, row-level security, and file storage. You ship something real from day one.',
      },
      {
        title: 'Iterate as fast as you learn',
        body: 'Need to change your data model? Describe the change to Backenly. It updates the schema and APIs automatically — no migration files, no refactoring sprints.',
      },
      {
        title: 'Rollback when things go wrong',
        body: 'Backenly maintains a deployment history. If a change breaks something, you can roll back instantly — no war room, no downtime.',
      },
    ],
    afterLaunch: [
      {
        heading: 'Iterate against live data without a migration war room',
        body: "The MVP phase is defined by schema churn: every user interview changes the data model. On a hand-built backend each change is a migration to write, review, and nervously apply. On Backenly a change is a sentence — planned against the live backend, applied as governed steps, verified behaviorally afterward. Additive changes just run. Destructive ones stop at an approval card with the live row count. Every change gets a restore point, so the cost of a wrong iteration is a rollback, not a weekend.",
      },
      {
        heading: 'Operational credibility before you can afford an ops team',
        body: "When the first real customers, partners, or investors ask hard questions — where does data live, who can access what, what happens when something breaks — an MVP on Backenly has better answers than most seed-stage startups with engineers: per-project database isolation, row-level security verified with evidence after every build, continuous monitoring of real traffic, an audit trail of every change with receipts, and rollback for every deploy. That is diligence-grade posture, on a $25/month plan, with an Enterprise tier (custom limits, SLA, onboarding help) waiting when a customer demands paperwork.",
      },
    ],
    faq: [
      {
        q: 'Can Backenly handle real production traffic?',
        a: 'Yes. Backenly runs on production-grade PostgreSQL infrastructure and is designed for real products with real users — not just prototypes.',
      },
      {
        q: 'How does Backenly compare to building our own backend?',
        a: 'Building a backend from scratch takes weeks of engineering time. Backenly does it in minutes. For most startups, that difference in speed is the difference between validating an idea and running out of runway.',
      },
      {
        q: 'What if we need to customize the backend beyond what Backenly generates?',
        a: 'Backenly supports custom event triggers, serverless AI functions, row-level security policies, and advanced API configuration. You can extend your backend without leaving the platform.',
      },
    ],
  },
  'ai-app-builders': {
    slug: 'ai-app-builders',
    label: 'AI App Builders',
    metaTitle: 'Backenly for AI App Builders — Backend Infrastructure for AI-Powered Products',
    metaDescription:
      'Building an AI-powered app? Backenly gives you structured data storage, user auth, realtime subscriptions, and event triggers — so your AI logic stays front and center.',
    headline: 'The backend your AI app deserves',
    subheadline:
      'Your product\'s value is in its AI. The backend should not be a distraction.',
    problem:
      'AI app builders spend enormous time on backend infrastructure — storing user conversations, managing user accounts, handling file uploads, triggering workflows — instead of improving the core AI experience.',
    solution:
      'Backenly handles all backend infrastructure automatically. Describe what your AI app needs to store and do, and Backenly generates the complete backend. You focus on making your AI smarter.',
    benefits: [
      {
        title: 'Structured storage for AI outputs',
        body: 'Store conversations, embeddings, user preferences, and AI-generated content in a properly structured PostgreSQL database — generated automatically from your description.',
      },
      {
        title: 'Event triggers for AI workflows',
        body: 'Trigger AI functions automatically on database events — when a user submits a form, when a record is created, when a threshold is crossed. Backenly handles the event routing.',
      },
      {
        title: 'User auth for AI products',
        body: 'Complete user authentication — sign-up, sign-in, sessions, and access control — included out of the box. No auth library to build or maintain.',
      },
      {
        title: 'Realtime for live AI experiences',
        body: 'Stream AI responses and live updates to users with built-in realtime subscriptions. No separate WebSocket infrastructure required.',
      },
    ],
    afterLaunch: [
      {
        heading: 'Pipelines and retrieval without extra infrastructure',
        body: "AI products accumulate infrastructure fast: a queue for async inference, a vector store for RAG, a socket layer for streaming status. On Backenly these are backend features, not separate systems. Event-triggered and scheduled functions run your processing when data changes (with plan quotas from 10,000 to 2 million invocations a month). pgvector-backed semantic search keeps embeddings inside PostgreSQL, under the same row-level security as everything else — so user A's retrieval can never surface user B's documents. Job status is a row your frontend subscribes to over SSE. One system, one access model, one bill.",
      },
      {
        heading: 'Your attention is the scarce resource',
        body: "An AI product lives or dies on model behavior, prompt quality, and iteration speed — the parts only you can do. The autonomy loop takes the part anyone shouldn't have to do: it watches request traffic and error rates every minute, repairs what is safe to repair, queues risky changes for approval, and writes receipts for everything. Rate limits on the runtime API keep a hot user or leaked key from turning into an inference bill. The backend defends itself, so your best hours go to the AI layer.",
      },
    ],
    faq: [
      {
        q: 'Can I connect Backenly to my AI model or LLM?',
        a: 'Yes. Backenly stores and serves data via REST APIs. Your AI logic can read from and write to Backenly like any other API. You can also use Backenly\'s serverless AI function layer to trigger model calls.',
      },
      {
        q: 'Can Backenly handle file storage for AI inputs like images or documents?',
        a: 'Yes. Backenly includes built-in file storage. You can upload files, generate signed URLs for secure access, and reference stored files from your database records.',
      },
      {
        q: 'Is Backenly suitable for AI products that need to scale quickly?',
        a: 'Yes. Backenly is production-grade infrastructure. You can start on the free plan and upgrade as your user base grows — without re-architecting your backend.',
      },
    ],
  },
  'side-projects': {
    slug: 'side-projects',
    label: 'Side Projects',
    metaTitle: 'Backenly for Side Projects — Free Backend, No Credit Card Required',
    metaDescription:
      'Ship your side project with a real backend — PostgreSQL, APIs, auth, and storage — completely free. No credit card required. No expiry. One permanent project on Backenly\'s free plan.',
    headline: 'Your side project deserves a real backend',
    subheadline:
      'Not a toy, not a tutorial project — a real production backend. Free, forever, no credit card.',
    problem:
      'Side projects die because the backend takes too long to build or costs money you do not want to spend on something unproven. Most free backend options are too limited for real apps.',
    solution:
      'Backenly\'s free plan gives your side project a complete, permanent backend — PostgreSQL database, REST APIs, authentication, and file storage — at no cost, with no expiry.',
    benefits: [
      {
        title: 'Permanently free, no expiry',
        body: 'One project on Backenly is free forever. Not a trial, not a free tier that expires. Your side project will keep running.',
      },
      {
        title: 'Real PostgreSQL, not a toy database',
        body: 'Your free project gets a real 512 MB PostgreSQL database — enough for most side projects to run indefinitely.',
      },
      {
        title: 'Auth and realtime included',
        body: 'User authentication and realtime subscriptions are included even on the free plan. You can build real, interactive apps — not just static pages.',
      },
      {
        title: 'Ship in a weekend',
        body: 'Describe your side project to Backenly on Saturday morning. Have a working product with a real backend by Saturday afternoon.',
      },
    ],
    afterLaunch: [
      {
        heading: 'Side projects die of maintenance, not launch',
        body: "Every developer knows the graveyard: side projects that shipped, worked, and quietly rotted because nobody wanted to spend Saturday debugging a database that filled up or an auth flow that broke. The free plan checks your project's health every minute and repairs what is safe to repair, even while you're ignoring it for months. That is the difference between a side project that is 'down, whenever I get to it' and one that is simply still running when someone shares it on a forum at 2 a.m.",
      },
      {
        heading: 'If it takes off, nothing gets rebuilt',
        body: "The upgrade path is a plan change, not a migration: the same PostgreSQL database, the same REST API, the same auth — with higher limits. The monitoring cadence does not change, because it is already every minute on Free. Side projects that become products keep their data and their URL. And because the backend is standard infrastructure with a full change history, the moment your weekend project becomes a company, a hired developer can read exactly what exists and why.",
      },
    ],
    faq: [
      {
        q: 'How long does the free project last?',
        a: 'Forever. The free plan is not a trial. Your project stays live as long as Backenly is operating.',
      },
      {
        q: 'What are the limits on the free plan?',
        a: 'The free plan includes 1 project, 200 AI credits per month, automated monitoring and self-repair every minute, up to 50,000 monthly active users, 512 MB PostgreSQL, 1 GB file storage, and full access to auth and realtime.',
      },
      {
        q: 'Can I upgrade if my side project takes off?',
        a: 'Yes. If your side project becomes something bigger, upgrade to Pro ($25/month) at any time — no data migration required.',
      },
    ],
  },
}

export function generateStaticParams() {
  return Object.keys(USE_CASES).map((slug) => ({ slug }))
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const uc = USE_CASES[params.slug]
  if (!uc) return { title: 'Not Found' }

  return {
    title: uc.metaTitle,
    description: uc.metaDescription,
    openGraph: {
      title: uc.metaTitle,
      description: uc.metaDescription,
      url: `${APP_URL}/use-cases/${uc.slug}`,
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title: uc.metaTitle,
      description: uc.metaDescription,
    },
    alternates: { canonical: `${APP_URL}/use-cases/${uc.slug}` },
  }
}

export default function UseCaseSlugPage({ params }: { params: { slug: string } }) {
  const uc = USE_CASES[params.slug]
  if (!uc) notFound()

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: uc.faq.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  }

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: APP_URL },
      { '@type': 'ListItem', position: 2, name: 'Use Cases', item: `${APP_URL}/use-cases` },
      { '@type': 'ListItem', position: 3, name: uc.label, item: `${APP_URL}/use-cases/${uc.slug}` },
    ],
  }

  return (
    <SiteShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(faqSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumbSchema) }}
      />
      <main className="relative z-20">
        <Breadcrumb
          items={[
            { label: 'Home', href: '/' },
            { label: 'Use Cases', href: '/use-cases' },
            { label: uc.label },
          ]}
        />

        <PageHero
          eyebrow={uc.label}
          title={uc.headline}
          subtitle={uc.subheadline}
          actions={
            <>
              <PrimaryButton href="/auth/signup">
                Start building free
                <InlineArrow />
              </PrimaryButton>
              <SecondaryButton href="/pricing">See pricing</SecondaryButton>
            </>
          }
          proof={[
            { label: 'Use case', value: uc.label },
            { label: 'Backend', value: 'Planned, applied, verified' },
            { label: 'Launch', value: 'Free to validate' },
          ]}
        />

        {/* Problem / Solution */}
        <Section className="!pt-0">
          <div className="flex flex-col gap-10">
            <div>
              <SectionHeading className="!text-xl mb-3">The problem</SectionHeading>
              <Lead>{uc.problem}</Lead>
            </div>
            <div>
              <SectionHeading className="!text-xl mb-3">How Backenly helps</SectionHeading>
              <Lead>{uc.solution}</Lead>
            </div>
          </div>
        </Section>

        {/* Benefits */}
        <Section aria-label="Key benefits">
          <SectionHeading className="mb-8">What you get</SectionHeading>
          <div className="grid gap-5 sm:grid-cols-2">
            {uc.benefits.map((benefit) => (
              <Card key={benefit.title}>
                <h3 className="text-base font-normal text-white mb-2">{benefit.title}</h3>
                <p className="text-sm text-neutral-400 font-extralight leading-relaxed">
                  {benefit.body}
                </p>
              </Card>
            ))}
          </div>
        </Section>

        {/* After launch — the operations story */}
        <Section aria-label="After launch" width="prose">
          <SectionHeading className="mb-8">After you launch</SectionHeading>
          <div className="flex flex-col gap-10">
            {uc.afterLaunch.map((section) => (
              <div key={section.heading}>
                <h3 className="text-xl font-light tracking-tight text-white mb-3">
                  {section.heading}
                </h3>
                <Lead>{section.body}</Lead>
              </div>
            ))}
          </div>
        </Section>

        {/* FAQ */}
        <Section aria-label="Frequently asked questions" width="prose">
          <SectionHeading className="mb-8">Common questions</SectionHeading>
          <FaqList items={uc.faq} />
        </Section>

        {/* Cross-links */}
        <Section aria-label="Other use cases" className="!py-12">
          <ChipRow label="More use cases:">
            {Object.values(USE_CASES)
              .filter((u) => u.slug !== uc.slug)
              .map((u) => (
                <ChipLink key={u.slug} href={`/use-cases/${u.slug}`}>
                  {u.label}
                </ChipLink>
              ))}
          </ChipRow>
        </Section>

        <CtaSection
          title="Start building your backend today"
          body="Free forever plan. No credit card. No infrastructure setup."
        >
          <PrimaryButton href="/auth/signup">Get started free</PrimaryButton>
        </CtaSection>
      </main>
    </SiteShell>
  )
}
