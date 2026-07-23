import { Metadata } from 'next'
import { safeJsonLd } from "@/lib/security/safe-jsonld"
import { Sparkles, Database, Lock, Zap, Rocket, type LucideIcon } from 'lucide-react'
import { SiteShell } from '@/components/site/SiteShell'
import {
  InlineArrow,
  PageHero,
  PrimaryButton,
  Section,
  SectionHeading,
  Lead,
  LinkCard,
  IconTile,
  Tag,
  CtaSection,
  ChipRow,
  ChipLink,
} from '@/components/site/kit'

const APP_URL = 'https://backenly.com'

export const metadata: Metadata = {
  title: 'Features — Everything Backenly Generates Automatically',
  description:
    'Backenly automatically generates AI backend infrastructure: PostgreSQL databases, REST APIs, user authentication, file storage, realtime subscriptions, event triggers, and deployment. No backend code required.',
  keywords: [
    'AI backend features',
    'automatic backend generation',
    'AI-generated APIs',
    'instant database setup',
    'backend authentication',
    'realtime backend',
  ],
  openGraph: {
    title: 'Backenly Features — AI-Generated Backend Infrastructure',
    description:
      'Everything your backend needs, generated automatically from a plain English description.',
    url: `${APP_URL}/features`,
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Backenly Features — AI-Generated Backend Infrastructure',
    description: 'PostgreSQL, REST APIs, auth, storage, realtime — all generated automatically.',
  },
  alternates: { canonical: `${APP_URL}/features` },
}

type FeatureCard = {
  slug: string
  icon: LucideIcon
  name: string
  tagline: string
  description: string
  keywords: string[]
}

const features: FeatureCard[] = [
  {
    slug: 'ai-backend-generation',
    icon: Sparkles,
    name: 'AI Backend Generation',
    tagline: 'Describe it, get it.',
    description:
      'Tell Backenly what you need in plain English. The AI understands intent, generates the full backend schema, APIs, auth, and storage — instantly.',
    keywords: ['AI backend generation', 'natural language backend', 'AI-generated backend'],
  },
  {
    slug: 'database-setup',
    icon: Database,
    name: 'Database Setup',
    tagline: 'PostgreSQL, zero configuration.',
    description:
      'Backenly generates a properly normalized PostgreSQL schema from your description. Tables, columns, foreign keys, indexes, and row-level security — all created automatically.',
    keywords: ['automatic database setup', 'PostgreSQL schema generation', 'AI database'],
  },
  {
    slug: 'authentication',
    icon: Lock,
    name: 'Authentication',
    tagline: 'User auth, built in.',
    description:
      'Complete user authentication included: sign-up, sign-in, JWT tokens, session management, and access control. No auth library to configure or maintain.',
    keywords: ['backend authentication', 'instant user auth', 'JWT authentication backend'],
  },
  {
    slug: 'api-generation',
    icon: Zap,
    name: 'Instant REST API',
    tagline: 'The API is your schema.',
    description:
      'Every table is served by PostgREST — the same engine Supabase runs — reading directly from the PostgreSQL catalog. Filters, ordering, pagination, and embedded resources, with authorization enforced by Postgres grants and RLS. Nothing to regenerate or keep in sync.',
    keywords: ['PostgREST API', 'instant REST API', 'PostgreSQL REST API', 'embedded resources'],
  },
  {
    slug: 'deployment-ready-backends',
    icon: Rocket,
    name: 'Deployment-Ready Backends',
    tagline: 'Live in under 60 seconds.',
    description:
      'Backenly deploys your backend automatically. No Docker, no Kubernetes, no cloud console. Your backend is live and accessible via a public URL immediately.',
    keywords: ['instant backend deployment', 'no DevOps backend', 'deploy backend automatically'],
  },
]

const softwareSchema = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Backenly',
  url: APP_URL,
  applicationCategory: 'DeveloperApplication',
  featureList: features.map((f) => f.name),
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
}

export default function FeaturesPage() {
  return (
    <SiteShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(softwareSchema) }}
      />
      <main className="relative z-20">
        <PageHero
          align="center"
          eyebrow="Features"
          title="Everything your backend needs, generated automatically"
          subtitle="Describe your backend in plain English. Backenly generates the complete infrastructure — database, APIs, auth, storage, and realtime — ready to use in minutes."
          actions={
            <PrimaryButton href="/auth/signup">
              Start building free
              <InlineArrow />
            </PrimaryButton>
          }
          proof={[
            { label: 'Data layer', value: 'PostgreSQL schemas' },
            { label: 'Runtime', value: 'REST APIs and auth' },
            { label: 'Operations', value: 'Monitoring and rollback' },
          ]}
        />

        {/* Feature cards */}
        <Section aria-label="Backenly features" width="wide" className="!pt-0">
          <div className="grid gap-6 sm:grid-cols-2">
            {features.map((feature) => {
              const Icon = feature.icon
              return (
                <LinkCard key={feature.slug} href={`/features/${feature.slug}`}>
                  <IconTile size={48}>
                    <Icon size={22} className="text-violet-300" strokeWidth={1.75} />
                  </IconTile>
                  <h2 className="mt-5 text-lg font-normal text-white tracking-tight">
                    {feature.name}
                  </h2>
                  <p className="text-sm font-normal text-violet-300 mt-1 mb-3">{feature.tagline}</p>
                  <p className="text-sm text-neutral-400 font-extralight leading-relaxed flex-1">
                    {feature.description}
                  </p>
                  <div className="mt-5 flex flex-wrap gap-1.5">
                    {feature.keywords.map((kw) => (
                      <Tag key={kw}>{kw}</Tag>
                    ))}
                  </div>
                  <p className="mt-5 text-sm font-semibold text-zinc-200 group-hover:text-white transition-colors">
                    Learn more
                  </p>
                </LinkCard>
              )
            })}
          </div>
        </Section>

        {/* How it works — GEO block */}
        <Section aria-label="How Backenly works" width="prose">
          <SectionHeading className="mb-8">How Backenly generates your backend</SectionHeading>
          <ol className="flex flex-col gap-6">
            {[
              { step: '1', title: 'Describe your backend', body: 'Write a plain English description of what your app needs — tables, relationships, auth rules, and any other requirements.' },
              { step: '2', title: 'AI generates the plan', body: "Backenly's AI understands your intent and creates a precise plan: database schema, API endpoints, auth configuration, storage buckets, and security policies." },
              { step: '3', title: 'Everything is created instantly', body: 'The plan is executed automatically — tables created, APIs deployed, auth configured. Your backend is live and accessible via a REST API within seconds.' },
              { step: '4', title: 'Continuous monitoring', body: 'Backenly monitors your backend continuously, detects drift or issues, and applies safe fixes automatically — without you having to ask.' },
            ].map((s) => (
              <li key={s.step} className="flex gap-5">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-violet-500/[0.15] border border-violet-400/30 flex items-center justify-center text-sm font-normal text-violet-300">
                  {s.step}
                </div>
                <div>
                  <h3 className="text-base font-normal text-white mb-1">{s.title}</h3>
                  <p className="text-sm text-neutral-400 font-extralight leading-relaxed">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </Section>

        {/* Internal links */}
        <Section width="prose" className="!py-12">
          <ChipRow label="Related:">
            {[
              { href: '/use-cases', label: 'Use cases' },
              { href: '/comparisons', label: 'Comparisons' },
              { href: '/alternatives', label: 'Alternatives' },
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
          title="See every feature in action"
          body="Free forever plan. No credit card. No infrastructure to set up."
        >
          <PrimaryButton href="/auth/signup">Get started free</PrimaryButton>
        </CtaSection>
      </main>
    </SiteShell>
  )
}
