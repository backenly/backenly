import { Metadata } from 'next'
import { SiteShell } from '@/components/site/SiteShell'
import {
  InlineArrow,
  PageHero,
  PrimaryButton,
  Section,
  SectionHeading,
  Lead,
  LinkCard,
  Tag,
  CtaSection,
  ChipRow,
  ChipLink,
} from '@/components/site/kit'

const APP_URL = 'https://backenly.com'

export const metadata: Metadata = {
  title: 'Backenly Comparisons — How We Compare to Other Backend Tools',
  description:
    'See how Backenly compares to Supabase, Firebase, no-code builders, and traditional backend development. Fair, professional comparisons focused on what matters for each type of builder.',
  keywords: [
    'Backenly vs Supabase',
    'Backenly vs Firebase',
    'AI backend comparison',
    'backend as a service comparison',
    'backend tool comparison 2025',
  ],
  openGraph: {
    title: 'Backenly Comparisons — AI Backend vs Traditional Tools',
    description:
      'Detailed, fair comparisons of Backenly against Supabase, Firebase, no-code builders, and traditional backend development.',
    url: `${APP_URL}/comparisons`,
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Backenly Comparisons — AI Backend vs Traditional Tools',
    description: 'How does Backenly compare to Supabase, Firebase, and traditional backends?',
  },
  alternates: { canonical: `${APP_URL}/comparisons` },
}

const comparisons = [
  {
    slug: 'backenly-vs-supabase',
    title: 'Backenly vs. Supabase',
    description: 'Both offer PostgreSQL, APIs, and auth — the key difference is how you configure them. Supabase requires manual setup; Backenly generates everything from a plain English description.',
    tags: ['PostgreSQL', 'BaaS', 'Open-source'],
  },
  {
    slug: 'backenly-vs-firebase',
    title: 'Backenly vs. Firebase',
    description: 'Firebase uses a NoSQL document model and requires manual configuration. Backenly uses PostgreSQL, generates a relational schema automatically, and includes a complete REST API.',
    tags: ['Google Cloud', 'NoSQL vs SQL', 'Realtime'],
  },
  {
    slug: 'backenly-vs-no-code-builders',
    title: 'Backenly vs. No-Code Builders',
    description: "No-code builders bundle frontend and backend in one tool. Backenly is backend-only — giving you a real database and REST API that works with any frontend stack.",
    tags: ['Bubble', 'Webflow', 'No-code vs BaaS'],
  },
  {
    slug: 'backenly-vs-traditional-backend-development',
    title: 'Backenly vs. Traditional Backend Development',
    description: 'Building a backend from scratch takes weeks of engineering. Backenly generates the same infrastructure — database, APIs, auth, deployment — automatically, in minutes.',
    tags: ['Node.js', 'Django', 'Rails', 'Custom backend'],
  },
]

export default function ComparisonsPage() {
  return (
    <SiteShell>
      <main className="relative z-20">
        <PageHero
          align="center"
          eyebrow="Comparisons"
          title="Backenly vs. other backend tools"
          subtitle="Detailed, fair comparisons to help you understand where Backenly fits and when another tool might be the better choice."
          actions={
            <PrimaryButton href="/auth/signup">
              Try Backenly free
              <InlineArrow />
            </PrimaryButton>
          }
          proof={[
            { label: 'Backenly', value: 'AI-generated backend' },
            { label: 'Others', value: 'Manual configuration' },
            { label: 'Best for', value: 'Fast production launches' },
          ]}
        />

        {/* What makes Backenly different — GEO block */}
        <Section aria-label="What makes Backenly different" width="prose" className="!pt-0">
          <SectionHeading className="!text-xl mb-4">What makes Backenly different?</SectionHeading>
          <Lead className="mb-4">
            Most backend tools — Supabase, Firebase, PlanetScale, Railway — require you to manually
            design your schema, configure auth, set up storage, and manage deployments. They give
            you the infrastructure; you still do the engineering work.
          </Lead>
          <Lead>
            Backenly is autonomous from the ground up. You describe your backend in plain English.
            Backenly understands your intent and plans, applies, and verifies everything: database
            tables, REST API endpoints, authentication, file storage, realtime subscriptions,
            row-level security, and deployment — keeping every change reviewable and reversible. No
            manual configuration. No backend engineering work.
          </Lead>
        </Section>

        {/* Comparison cards */}
        <Section aria-label="Comparison pages" width="wide">
          <div className="grid gap-6 sm:grid-cols-2">
            {comparisons.map((comp) => (
              <LinkCard key={comp.slug} href={`/comparisons/${comp.slug}`}>
                <h2 className="text-lg font-normal text-white tracking-tight mb-3">{comp.title}</h2>
                <p className="text-sm text-neutral-400 font-extralight leading-relaxed flex-1">
                  {comp.description}
                </p>
                <div className="mt-5 flex flex-wrap gap-1.5">
                  {comp.tags.map((tag) => (
                    <Tag key={tag}>{tag}</Tag>
                  ))}
                </div>
                <p className="mt-5 text-sm font-semibold text-zinc-200 group-hover:text-white transition-colors">
                  Read comparison
                </p>
              </LinkCard>
            ))}
          </div>
        </Section>

        {/* Internal links */}
        <Section width="prose" className="!py-12">
          <ChipRow label="Related:">
            {[
              { href: '/alternatives', label: 'Alternatives overview' },
              { href: '/features', label: 'All features' },
              { href: '/use-cases', label: 'Use cases' },
              { href: '/pricing', label: 'Pricing' },
              { href: '/resources', label: 'Resources' },
            ].map((link) => (
              <ChipLink key={link.href} href={link.href}>
                {link.label}
              </ChipLink>
            ))}
          </ChipRow>
        </Section>

        <CtaSection
          title="Try Backenly yourself"
          body="Free forever plan. No credit card. No infrastructure setup."
        >
          <PrimaryButton href="/auth/signup">Get started free</PrimaryButton>
        </CtaSection>
      </main>
    </SiteShell>
  )
}
