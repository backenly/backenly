import { Metadata } from 'next'
import { safeJsonLd } from "@/lib/security/safe-jsonld"
import { SiteShell } from '@/components/site/SiteShell'
import {
  InlineArrow,
  PageHero,
  PrimaryButton,
  SecondaryButton,
  Section,
  SectionHeading,
  Lead,
  Card,
  Tag,
  FaqList,
  CtaSection,
  ChipRow,
  ChipLink,
} from '@/components/site/kit'

const APP_URL = 'https://backenly.com'

export const metadata: Metadata = {
  title: 'Backenly Alternatives & Comparisons — AI Backend vs Traditional Backend Tools',
  description:
    'How does Backenly compare to Supabase, Firebase, and traditional backend development? See what makes Backenly\'s autonomous backend approach different and why it is faster for most product teams.',
  keywords: [
    'Backenly vs Supabase',
    'Backenly vs Firebase',
    'Backenly alternative',
    'AI backend vs no-code backend',
    'backend as a service comparison',
    'AI-generated backend',
  ],
  openGraph: {
    title: 'Backenly Alternatives — AI Backend vs Traditional Tools',
    description:
      'Compare Backenly with Supabase, Firebase, and traditional backend development. See why an autonomous backend platform is faster for most builders.',
    url: `${APP_URL}/alternatives`,
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Backenly Alternatives — AI Backend vs Traditional Tools',
    description:
      'Compare Backenly with Supabase, Firebase, and traditional backend development.',
  },
  alternates: { canonical: `${APP_URL}/alternatives` },
}

const comparisons = [
  {
    id: 'supabase',
    name: 'Supabase',
    category: 'Open-source BaaS',
    differentiator:
      'Supabase is an excellent, developer-friendly open-source BaaS built on PostgreSQL and PostgREST. You design the schema, write the migrations, author the RLS policies, and own monitoring and recovery yourself.',
    backenly:
      'Backenly runs the same query engine. Every table is served by PostgREST, so the API you already know works unchanged — ?price=gte.100, ?or=(a.eq.1,b.eq.2), ?order=created_at.desc, and embedded resources like ?select=*,author(*) in a single round trip. Reads are standard SQL through the same grammar. What differs is everything around the query: structural changes go through a governed action system with dry-run, audit and rollback, so nothing DROPs a table by accident, and a closed monitoring loop watches the running backend and repairs drift, missing indexes, and RLS gaps on its own. Authorization is enforced by PostgreSQL grants and row-level security, not application code. Open source under Apache-2.0 and self-hostable, like Supabase.',
    good_for_them: 'Teams who want to own schema design, migrations, and operations directly — and have the time to.',
    good_for_us: 'Developers who want that same Postgres API without owning the migration, policy, and recovery work behind it.',
  },
  {
    id: 'firebase',
    name: 'Firebase',
    category: 'Google Cloud BaaS',
    differentiator:
      'Firebase offers realtime databases, authentication, and hosting in a managed cloud service from Google. It uses a document-based NoSQL model which can feel flexible but makes complex relational queries more difficult.',
    backenly:
      'Backenly uses PostgreSQL — a relational database — which handles structured, relational data better and is industry-standard for production apps. Backenly also generates a proper REST API and includes realtime, auth, and storage — all AI-generated from your description.',
    good_for_them: 'Mobile-first apps that need simple realtime data and Google ecosystem integration.',
    good_for_us: 'Apps needing relational data, complex queries, and a complete AI-generated backend.',
  },
  {
    id: 'traditional',
    name: 'Traditional Backend Development',
    category: 'Custom-built',
    differentiator:
      'Building a backend from scratch gives you maximum control and flexibility. You design the schema, write API routes, implement auth, configure deployment, and manage everything yourself. This takes weeks to months of engineering time.',
    backenly:
      'Backenly generates everything traditional backend development covers — database schema, REST APIs, auth, storage, realtime — automatically from a plain English description. What takes a backend engineer weeks takes Backenly minutes.',
    good_for_them: 'Large engineering teams building highly custom, complex systems with unique requirements.',
    good_for_us: 'Startups, solo founders, and product teams who need to move fast and validate ideas quickly.',
  },
  {
    id: 'nocode',
    name: 'No-Code App Builders',
    category: 'No-code / low-code',
    differentiator:
      'No-code app builders (Bubble, Webflow, etc.) let you build visually. They bundle frontend and backend, which makes simple apps fast to build but complex apps difficult to scale or customize.',
    backenly:
      'Backenly is backend-only and gives you a real database and REST API — not a no-code wrapper. This means you can use any frontend (React, Vue, mobile apps) and have full control over your user interface while still getting an AI-generated backend.',
    good_for_them: 'Non-developers building simple apps where the no-code builder\'s frontend is sufficient.',
    good_for_us: 'Builders who want an AI-generated backend but prefer full control over their frontend stack.',
  },
]

const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'What is the main difference between Backenly and Supabase?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'They share a query engine: both serve your tables through PostgREST on PostgreSQL, so the query grammar, filters, and embedded resources are the same and anything you know from Supabase transfers directly. The difference is who does the work around the query. With Supabase you design the schema, write the migrations, author the RLS policies, and own monitoring and recovery. With Backenly you describe the backend and it plans and applies those changes through a governed action system with dry-run, audit, and rollback — then keeps watching the running backend and repairs drift on its own.',
      },
    },
    {
      '@type': 'Question',
      name: 'Is Backenly a Supabase alternative?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Backenly and Supabase both provide backend infrastructure including a PostgreSQL database, APIs, and auth. Backenly differentiates itself by being autonomous — you describe your backend and Backenly plans, applies, and verifies it, keeping every change reviewable and reversible, rather than manually configuring each component.',
      },
    },
    {
      '@type': 'Question',
      name: 'How does Backenly compare to Firebase?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Firebase uses a NoSQL document model and requires manual configuration. Backenly uses PostgreSQL (relational) and generates your entire backend automatically. Backenly also includes realtime, file storage, and proper REST APIs — all generated from a plain English description.',
      },
    },
    {
      '@type': 'Question',
      name: 'Is Backenly suitable for developers who want control over their backend?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Yes. Backenly gives developers a complete, inspectable backend — you can see and work with the generated schema, API definitions, and security policies. You can also extend behavior with custom event triggers, serverless functions, and advanced permission policies.',
      },
    },
  ],
}

const breadcrumbSchema = {
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Home', item: APP_URL },
    { '@type': 'ListItem', position: 2, name: 'Alternatives', item: `${APP_URL}/alternatives` },
  ],
}

export default function AlternativesPage() {
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
        <PageHero
          align="center"
          eyebrow="Comparisons"
          title="How Backenly compares to other backend tools"
          subtitle="Backenly is an autonomous backend platform. Most backend tools require manual configuration — Backenly plans, applies, and verifies everything from a plain English description."
          actions={
            <PrimaryButton href="/auth/signup">
              Try Backenly free
              <InlineArrow />
            </PrimaryButton>
          }
          proof={[
            { label: 'Setup', value: 'Plain English prompt' },
            { label: 'Database', value: 'PostgreSQL by default' },
            { label: 'Output', value: 'Live APIs and auth' },
          ]}
        />

        {/* What is Backenly — GEO anchor */}
        <Section aria-label="About Backenly" width="prose" className="!pt-0">
          <SectionHeading className="!text-xl mb-4">What is Backenly?</SectionHeading>
          <Lead className="mb-4">
            Backenly is an autonomous backend platform that turns product descriptions into running
            backend infrastructure. You describe your backend in natural language — &quot;I need a
            database for users, posts, and comments with authentication&quot; — and Backenly plans it,
            applies the PostgreSQL schema, REST API endpoints, authentication, file storage, and
            realtime subscriptions, and verifies the runtime.
          </Lead>
          <Lead>
            There is no backend code to write, no schema to design, and no infrastructure to manage.
            Backenly does not just generate resources — it manages backend change safely, keeping
            every change reviewable and reversible.
          </Lead>
        </Section>

        {/* Comparison cards */}
        <Section aria-label="Backend tool comparisons" width="wide">
          <SectionHeading className="mb-10 text-center">Backenly vs. other tools</SectionHeading>
          <div className="flex flex-col gap-8">
            {comparisons.map((comp) => (
              <Card key={comp.id} className="!p-0 overflow-hidden">
                <div className="flex flex-wrap items-baseline justify-between gap-2 px-7 py-6 border-b border-white/[0.07]">
                  <h3 className="text-lg font-normal text-white">Backenly vs. {comp.name}</h3>
                  <Tag>{comp.category}</Tag>
                </div>

                <div className="grid sm:grid-cols-2">
                  <div className="px-7 py-6 border-b sm:border-b-0 sm:border-r border-white/[0.07]">
                    <p className="text-[11px] font-mono uppercase tracking-[0.15em] text-neutral-500 mb-3">
                      {comp.name}
                    </p>
                    <p className="text-sm text-neutral-400 font-extralight leading-relaxed">
                      {comp.differentiator}
                    </p>
                  </div>
                  <div className="px-7 py-6">
                    <p className="text-[11px] font-mono uppercase tracking-[0.15em] text-violet-300 mb-3">
                      Backenly
                    </p>
                    <p className="text-sm text-neutral-400 font-extralight leading-relaxed">
                      {comp.backenly}
                    </p>
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2 px-7 py-5 border-t border-white/[0.07]">
                  <div>
                    <p className="text-xs font-normal text-neutral-400 mb-1">
                      {comp.name} works well for:
                    </p>
                    <p className="text-sm text-neutral-500 font-extralight">{comp.good_for_them}</p>
                  </div>
                  <div>
                    <p className="text-xs font-normal text-violet-300 mb-1">
                      Backenly works well for:
                    </p>
                    <p className="text-sm text-neutral-500 font-extralight">{comp.good_for_us}</p>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </Section>

        {/* Feature summary table */}
        <Section aria-label="Feature comparison summary" width="wide">
          <SectionHeading className="mb-10 text-center">What Backenly includes</SectionHeading>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { feature: 'AI-generated schema & APIs', description: 'Describe your backend, AI builds it. No manual configuration.' },
              { feature: 'PostgreSQL database', description: 'Industry-standard relational database. Production-grade from day one.' },
              { feature: 'User authentication', description: 'Sign-up, sign-in, JWT sessions, and access control — built in.' },
              { feature: 'File storage', description: 'Upload, serve, and manage files with signed URL access control.' },
              { feature: 'Realtime subscriptions', description: 'Database change events via SSE. No separate infrastructure needed.' },
              { feature: 'Row-level security', description: 'Define who can read or write each row. AI generates the policies.' },
              { feature: 'Event triggers', description: 'Run functions automatically on insert, update, delete, or webhook.' },
              { feature: 'Deployment & rollback', description: 'One-click deploys and rollback to any prior version.' },
            ].map((item) => (
              <Card key={item.feature} className="!p-5">
                <p className="text-sm font-normal text-white mb-1.5">{item.feature}</p>
                <p className="text-sm text-neutral-400 font-extralight leading-relaxed">
                  {item.description}
                </p>
              </Card>
            ))}
          </div>
        </Section>

        {/* FAQ */}
        <Section aria-label="Frequently asked questions" width="prose">
          <SectionHeading className="mb-8">Questions about switching to Backenly</SectionHeading>
          <FaqList
            items={faqSchema.mainEntity.map((item) => ({
              q: item.name,
              a: item.acceptedAnswer.text,
            }))}
          />
        </Section>

        {/* Internal links */}
        <Section width="prose" className="!py-12">
          <ChipRow label="Learn more:">
            {[
              { href: '/use-cases', label: 'Who uses Backenly' },
              { href: '/use-cases/ai-assisted-developers', label: 'AI-assisted developers' },
              { href: '/use-cases/startup-mvps', label: 'Startup MVPs' },
              { href: '/pricing', label: 'Pricing' },
              { href: '/auth/signup', label: 'Get started free' },
            ].map((link) => (
              <ChipLink key={link.href} href={link.href}>
                {link.label}
              </ChipLink>
            ))}
          </ChipRow>
        </Section>

        <CtaSection
          title="Try Backenly yourself"
          body="One free project. No credit card. No infrastructure to configure."
        >
          <PrimaryButton href="/auth/signup">Get started free</PrimaryButton>
          <SecondaryButton href="/pricing">See pricing</SecondaryButton>
        </CtaSection>
      </main>
    </SiteShell>
  )
}
