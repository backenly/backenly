import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { pageMetadata, SITE_URL } from '@/lib/seo/metadata'
import { graph, ORGANIZATION_ID } from '@/lib/seo/schema'
import { CodeBlock } from '@/components/site/CodeBlock'
import { Faq } from '@/components/site/Faq'
import { StartButton } from '@/components/site/StartButton'
import { BentoCell, CellBody, CellTitle } from '@/components/landing-v7/shared'
import { ButtonLink, HorizonClose, NextLinks, Section, SectionHead, withCode } from '@/components/site/kit'
import { MEASURE, TEXT_LINK, TITLE } from '@/components/site/tokens'
import { AGENTS_UPDATED, type AgentPageBase, type FaqItem, type NextItem } from './data'

/* ─────────────────────────────────────────────────────────────
   What the /agents pages share: their metadata and structured data, the FAQ
   block, where to go next, and the close. Each page composes its own
   sections from app/agents/data.ts, because each agent's setup has a
   different shape (three commands for Claude Code, a JSON file for Cursor).

   Built the way #541 rebuilt the subpages to match the landing: two-tone
   section titles at the default size, the landing's bento cells, the landing
   FAQ's header, and the rising close.
───────────────────────────────────────────────────────────── */

/** The gap between a section title and its first cell. */
export const BODY_GAP = 'mt-[40px] md:mt-[56px]'

/**
 * The landing FAQ's two links, as /mcp sets them: the setup guide, and the
 * founders. Literal for the reason app/alternatives gives: keep FOUNDERS_HREF
 * equal to ROUTES.founder.
 */
const DOCS_HREF = '/docs/connect'
const FOUNDERS_HREF = 'https://calendly.com/adarsh-c-jose/30min'

export const agentPath = (page: AgentPageBase) => `/agents/${page.slug}`

export function agentMetadata(page: AgentPageBase): Metadata {
  return pageMetadata({
    title: page.metaTitle,
    description: page.metaDescription,
    path: agentPath(page),
    type: 'article',
    modifiedTime: AGENTS_UPDATED,
  })
}

/**
 * The article, its FAQ and its trail, and nothing that is not on the page. The
 * trail is Home / MCP server / the agent, as the hero renders it: every crumb a
 * real page, so every list item carries its URL.
 */
export function agentStructuredData(page: AgentPageBase) {
  const url = `${SITE_URL}${agentPath(page)}`
  return graph(
    {
      '@type': 'TechArticle',
      headline: page.title,
      description: page.metaDescription,
      datePublished: AGENTS_UPDATED,
      dateModified: AGENTS_UPDATED,
      author: { '@id': ORGANIZATION_ID },
      publisher: { '@id': ORGANIZATION_ID },
      url,
      mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    },
    {
      '@type': 'FAQPage',
      mainEntity: page.faq.map((item) => ({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: { '@type': 'Answer', text: item.a },
      })),
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL },
        { '@type': 'ListItem', position: 2, name: 'MCP server', item: `${SITE_URL}/mcp` },
        { '@type': 'ListItem', position: 3, name: page.name, item: url },
      ],
    },
  )
}

/** The hero trail, mirrored by the BreadcrumbList above. */
export const agentTrail = (page: AgentPageBase) => [
  { label: 'Home', href: '/' },
  { label: 'MCP server', href: '/mcp' },
  { label: page.name },
]

/**
 * A cell's code, under its body. Rows whose cells all carry code give the
 * bodies a floor (as /alternatives does for its answers), so the blocks in a
 * row start on one line.
 */
export function CellCode({
  code,
  language = 'bash',
  label,
  className = 'mt-[24px]',
}: {
  code: string
  language?: string
  label?: string
  className?: string
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      {/* One-line commands wrap so the whole command is visible; JSON and multi-line commands keep their lines. */}
      <CodeBlock code={code} language={language} label={label} wrap={language !== 'json' && !code.includes('\n')} />
    </div>
  )
}

/** A quiet line under a row of cells, with `code` rendered inline. */
export function Note({ children, className = '' }: { children: string; className?: string }) {
  return (
    <p className={`${MEASURE} text-[15px] leading-[1.7] text-zinc-400 [text-wrap:pretty] ${className}`}>
      {withCode(children)}
    </p>
  )
}

/**
 * The one cell in a section that carries code, set wide under the others: its
 * words beside its block, the lead-cell layout of /comparisons.
 */
export function WideCodeCell({
  title,
  body,
  code,
  language = 'bash',
  label,
}: {
  title: string
  body: string
  code: string
  language?: string
  label?: string
}) {
  return (
    <BentoCell className="h-full">
      <div className="grid gap-[24px] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-center lg:gap-[32px]">
        <div className="min-w-0">
          <CellTitle>{title}</CellTitle>
          <CellBody className="[text-wrap:pretty]">{withCode(body)}</CellBody>
        </div>
        <CellCode code={code} language={language} label={label} className="" />
      </div>
    </BentoCell>
  )
}

/** The landing FAQ's layout: the title, its line and two links sticky on the left, the questions on the right. */
export function AgentFaq({ id, title, items }: { id: string; title: string; items: FaqItem[] }) {
  return (
    <Section aria-labelledby={id}>
      <div className="grid gap-[40px] lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-[64px]">
        <div className="lg:sticky lg:top-[112px] lg:self-start">
          <SectionHead id={id} title={title} />
          {/* The landing FAQ's own close to the header. */}
          <p className="mt-5 max-w-[36ch] text-[15px] leading-[1.7] text-zinc-400">
            Anything else, ask the people who built it.
          </p>
          <div className="mt-7 flex flex-wrap gap-x-6 gap-y-3">
            <Link href={DOCS_HREF} className={TEXT_LINK}>
              Read the setup guide
              <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
            </Link>
            <a href={FOUNDERS_HREF} target="_blank" rel="noopener noreferrer" className={TEXT_LINK}>
              Book 30 minutes
              <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
            </a>
          </div>
        </div>
        <Faq items={items} />
      </div>
    </Section>
  )
}

export function AgentNext({ items }: { items: NextItem[] }) {
  return (
    <Section aria-labelledby="agent-next">
      <h2 id="agent-next" className={`text-[22px] text-white md:text-[26px] ${TITLE}`}>
        Read next
      </h2>
      <NextLinks className="mt-[28px]" items={items} />
    </Section>
  )
}

export function AgentClose({ page }: { page: AgentPageBase }) {
  return (
    <HorizonClose title={page.close.title} lede={page.close.lede}>
      <StartButton />
      <ButtonLink href="/pricing" variant="secondary">
        See pricing
      </ButtonLink>
    </HorizonClose>
  )
}
