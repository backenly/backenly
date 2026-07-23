import { Metadata } from 'next'
import { safeJsonLd } from "@/lib/security/safe-jsonld"
import { BookOpen, Compass, Layers3 } from 'lucide-react'
import { SiteShell } from '@/components/site/SiteShell'
import { articles } from './data'
import {
  Card,
  InlineArrow,
  PageHero,
  PrimaryButton,
  Section,
  SectionIntro,
  LinkCard,
  Tag,
  ChipRow,
  ChipLink,
} from '@/components/site/kit'

const APP_URL = 'https://backenly.com'

export const metadata: Metadata = {
  title: 'Resources — Guides on Autonomous Backends & Agent-Native Development',
  description:
    'Practical guides on building production backends that run themselves: choosing an autonomous backend over no-code and traditional BaaS, designing for real users, and driving your backend from a coding agent over MCP.',
  keywords: [
    'autonomous backend platform',
    'backend for coding agents',
    'AI backend development guide',
    'how to build a production backend',
    'BaaS alternative',
  ],
  openGraph: {
    title: 'Backenly Resources — Autonomous Backends & Agent-Native Development',
    description:
      'Practical guides on building production backends that plan, apply, verify, and heal themselves — and connect cleanly to coding agents over MCP.',
    url: `${APP_URL}/resources`,
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Backenly Resources — Autonomous Backends & Agent-Native Development',
    description: 'Guides on building production backends that run themselves and connect to your coding agent.',
  },
  alternates: { canonical: `${APP_URL}/resources` },
}

const collectionSchema = {
  '@context': 'https://schema.org',
  '@type': 'CollectionPage',
  name: 'Backenly Resources',
  description: 'Practical guides on building production backends that run themselves, choosing an autonomous backend over no-code and BaaS, and connecting coding agents cleanly.',
  url: `${APP_URL}/resources`,
  publisher: { '@type': 'Organization', name: 'Backenly', url: APP_URL },
}

const learningPaths = [
  {
    icon: Compass,
    title: 'Choose the right backend',
    body: 'Understand where an autonomous backend fits against no-code tools, traditional engineering, and BaaS platforms — and what "runs itself" actually means.',
  },
  {
    icon: Layers3,
    title: 'Design production-ready foundations',
    body: 'Think through data models, auth boundaries, storage, realtime, and the operational surface — monitoring, rollback, and governance — before real users arrive.',
  },
  {
    icon: BookOpen,
    title: 'Build with coding agents',
    body: 'Connect Claude Code or Cursor over MCP — your agent reads the live schema and builds against real tables, auth, and storage, never a throwaway mock.',
  },
]

export default function ResourcesPage() {
  return (
    <SiteShell>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(collectionSchema) }} />
      <main className="relative z-20">
        <PageHero
          align="center"
          eyebrow="Resources"
          title="Guides for backends that run themselves"
          subtitle="Practical guides on backend architecture, operating a backend with real users on it, and driving backend changes from a coding agent over MCP. Every claim in these guides describes the live product."
          actions={
            <PrimaryButton href="/auth/signup">
              Start building free
              <InlineArrow />
            </PrimaryButton>
          }
          proof={[
            { label: 'Audience', value: 'Developers and founders' },
            { label: 'Focus', value: 'Autonomous backends' },
            { label: 'Code samples', value: 'Real SDK surface' },
          ]}
        />

        <Section aria-label="Learning paths" width="wide" className="!pt-0">
          <SectionIntro
            align="center"
            eyebrow="Learning paths"
            title="Start with the decision, then go deeper"
            body="The guides are organized around three decisions: which backend approach fits your product, what to get right before real users arrive, and how to wire your tools to it."
          />
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {learningPaths.map((path) => {
              const Icon = path.icon

              return (
                <Card key={path.title}>
                  <div className="flex h-10 w-10 items-center justify-center rounded-md border border-white/10 bg-black/35">
                    <Icon className="h-5 w-5 text-zinc-200" />
                  </div>
                  <h2 className="mt-5 text-lg font-semibold text-white">{path.title}</h2>
                  <p className="mt-3 text-sm leading-6 text-zinc-400">{path.body}</p>
                </Card>
              )
            })}
          </div>
        </Section>

        {/* Article list */}
        <Section aria-label="Articles and guides" width="wide">
          <SectionIntro
            eyebrow="Latest guides"
            title="Practical reading for shipping teams"
            body="Each guide covers one decision — with the trade-offs, the failure modes, and working code where it helps."
          />
          <div className="grid gap-5 md:grid-cols-2">
            {articles.map((article, index) => (
              <LinkCard
                key={article.slug}
                href={`/resources/${article.slug}`}
                className={index === 0 ? 'md:col-span-2 md:p-8' : ''}
              >
                <div className="flex flex-wrap items-center gap-3 mb-3">
                  <Tag>{article.category}</Tag>
                  <span className="text-xs text-neutral-500">{article.readTime}</span>
                  <span className="text-xs text-neutral-600">{article.date}</span>
                </div>
                <h2 className={`${index === 0 ? 'text-2xl md:text-3xl' : 'text-lg'} font-semibold text-white leading-tight mb-3`}>
                  {article.title}
                </h2>
                <p className="text-sm text-neutral-400 font-extralight leading-relaxed">
                  {article.description}
                </p>
                <p className="mt-4 text-sm font-semibold text-zinc-200 group-hover:text-white transition-colors">
                  Read article
                </p>
              </LinkCard>
            ))}
          </div>
        </Section>

        {/* Internal links */}
        <Section width="prose" className="!py-12">
          <ChipRow label="Explore Backenly:">
            {[
              { href: '/features', label: 'Features' },
              { href: '/use-cases', label: 'Use cases' },
              { href: '/comparisons', label: 'Comparisons' },
              { href: '/alternatives', label: 'Alternatives' },
              { href: '/pricing', label: 'Pricing' },
            ].map((link) => (
              <ChipLink key={link.href} href={link.href}>
                {link.label}
              </ChipLink>
            ))}
          </ChipRow>
        </Section>
      </main>
    </SiteShell>
  )
}
