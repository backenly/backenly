import type { Metadata } from 'next'
import Link from 'next/link'
import { ListChecks } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { pageMetadata, SITE_URL } from '@/lib/seo/metadata'
import { graph, ORGANIZATION_ID } from '@/lib/seo/schema'
import { SiteShell } from '@/components/site/SiteShell'
import { DataTable, JsonLd, NextLinks, Page, withCode } from '@/components/site/kit'
import { PROSE_LINK } from '@/components/site/tokens'
import {
  GuideDocument,
  GuideMetaDivider,
  GuideRows,
  GuideSection,
  GuideSource as Source,
  GuideSubHeading,
  GUIDE_TEXT,
  guideDate,
} from '@/components/site/guide'
import {
  ACCESSED,
  ALTERNATIVES,
  COMPARISON,
  CRITERIA,
  GUIDE_PATH,
  GUIDE_UPDATED,
  NOTES,
  OPTIONS,
  READ_NEXT,
  isBackenlySource,
  sourceLabel,
  type Claim,
  type CriterionId,
  type GroupId,
} from './content'

/* ─────────────────────────────────────────────────────────────
   /guides/best-backend-for-claude-code

   A criteria-based guide for choosing the backend a coding agent builds on:
   the questions that matter once an agent writes to production, what seven
   common choices document for each, and when Backenly is the wrong one.
   Backenly wrote it and is one of the seven, so every row restates and links
   its source: the vendor's own pages for the others, this repository for
   Backenly. The facts are ./content.ts, held to their sources by
   tests/unit/best-backend-guide-conformance.spec.ts.

   Set as a document, like the other guide: components/site/guide.tsx.
───────────────────────────────────────────────────────────────────── */

const TITLE = 'Best backend for Claude Code: how to choose one'
const DESCRIPTION =
  'What to check before Claude Code changes your production backend, and what Supabase, Neon, Convex, Appwrite, Firebase, InsForge and Backenly each document.'

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: GUIDE_PATH,
  type: 'article',
  modifiedTime: GUIDE_UPDATED,
})

const URL = `${SITE_URL}${GUIDE_PATH}`

/** The sections, in order: the headings below and the "On this page" rail. */
const TOC: { id: string; label: string }[] = [
  { id: 'criteria', label: 'What to check' },
  { id: 'agent', label: 'Connecting the agent' },
  { id: 'changes', label: 'Changes and restores' },
  { id: 'running', label: 'After the agent leaves' },
  { id: 'platform', label: 'The platform' },
  { id: 'other', label: 'When to pick something else' },
  { id: 'method', label: 'How this was checked' },
  { id: 'next', label: 'Read next' },
]

const READ = GUIDE_TEXT

const structuredData = graph(
  {
    '@type': 'TechArticle',
    headline: TITLE,
    description: DESCRIPTION,
    datePublished: GUIDE_UPDATED,
    dateModified: GUIDE_UPDATED,
    author: { '@id': ORGANIZATION_ID },
    publisher: { '@id': ORGANIZATION_ID },
    url: URL,
    mainEntityOfPage: { '@type': 'WebPage', '@id': URL },
  },
  {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL },
      { '@type': 'ListItem', position: 2, name: 'Best backend for Claude Code', item: URL },
    ],
  },
)

/** A section under its rail label, or a longer heading. */
function Part({ id, title, children }: { id: string; title?: string; children: ReactNode }) {
  return (
    <GuideSection id={id} title={title ?? TOC.find((item) => item.id === id)!.label}>
      {children}
    </GuideSection>
  )
}

/** The pages a set of claims restates, each once, in order. */
function sourcesOf(claims: readonly Claim[]): string[] {
  return [...new Set(claims.map((c) => c.source))]
}

/** A row's heading: the backend, and under it the pages its cell restates. */
function RowHead({ name, claims }: { name: string; claims: readonly Claim[] }) {
  return (
    <>
      <span className="block">{name}</span>
      <span className="mt-[6px] flex flex-col items-start gap-[2px] text-[13px] font-normal">
        {sourcesOf(claims).map((url) => (
          <Source key={url} href={url}>
            {sourceLabel(url)}
          </Source>
        ))}
      </span>
    </>
  )
}

/**
 * Claims as prose, each about another product followed by the page it
 * restates. Backenly's own statements are not cited inline: the tables link
 * their sources, and a file path in the middle of a sentence reads as noise.
 */
function Cited({ claims }: { claims: readonly Claim[] }) {
  return (
    <>
      {claims.map((c, index) => {
        const cite = !isBackenlySource(c.source)
        const ends = cite && c.text.endsWith('.')
        return (
          <Fragment key={index}>
            {index > 0 && ' '}
            {withCode(ends ? c.text.slice(0, -1) : c.text)}
            {cite && (
              <>
                {' '}
                (<Source href={c.source}>{sourceLabel(c.source)}</Source>)
              </>
            )}
            {ends && '.'}
          </Fragment>
        )
      })}
    </>
  )
}

/** One criterion: its question, and what each backend documents for it. */
function Criterion({ id }: { id: CriterionId }) {
  const criterion = CRITERIA.find((c) => c.id === id)!
  return (
    <>
      <GuideSubHeading>{criterion.title}</GuideSubHeading>
      <DataTable
        caption={`${criterion.title}: what each backend documents, and the page each row restates`}
        columns={['Backend', 'What it documents']}
        minWidth="min-w-[480px]"
        rows={OPTIONS.map((option) => {
          const claims = COMPARISON[option.id][id]
          return [<RowHead key={option.id} name={option.name} claims={claims} />, withCode(claims.map((c) => c.text).join(' '))]
        })}
      />
    </>
  )
}

/** The criteria a comparison section covers, in order. */
function criteriaIn(group: GroupId): CriterionId[] {
  return CRITERIA.filter((c) => c.group === group).map((c) => c.id)
}

export default function BestBackendGuide() {
  return (
    <SiteShell>
      <JsonLd json={safeJsonLd(structuredData)} />
      <Page>
        <GuideDocument
          icon={ListChecks}
          title={TITLE}
          crumb="Best backend for Claude Code"
          summary="Claude Code can create tables, run migrations and delete rows through a backend’s MCP server, and the backend decides what happens when one of those calls is wrong. This guide sets out what to check, what Supabase, Neon, Convex, Appwrite, Firebase, InsForge and Backenly document today, and when to pick something other than Backenly."
          meta={
            <>
              <span>Updated {guideDate(GUIDE_UPDATED)}</span>
              <GuideMetaDivider />
              <span>Written by Backenly, one of the seven options</span>
              <GuideMetaDivider />
              <span>Every row links its source</span>
            </>
          }
          toc={TOC}
          close="One free project, no credit card. Connect Claude Code with a read-only key first, then ask for a change and see what waits for you."
        >
          <Part id="criteria">
            <p className={READ}>
              Connected over MCP, Claude Code calls a backend’s tools itself: it reads the schema, writes a migration
              and runs it, often several calls in one turn. What matters most is what happens when one of those calls
              is wrong. These are the nine questions this guide asks of each backend, and you can ask them of any
              other.
            </p>
            <GuideRows
              items={CRITERIA.map((c) => (
                <>
                  <span className="text-white">{c.title}.</span> {c.why}
                </>
              ))}
            />
          </Part>

          <Part id="agent" title="Connecting the agent">
            <p className={READ}>
              All seven have an official MCP server. Where it runs decides whose credentials it acts with, and a
              read-only mode decides whether a question about production can turn into a write.
            </p>
            {criteriaIn('agent').map((id) => (
              <Criterion key={id} id={id} />
            ))}
            <p className={READ}>
              Two of the vendors also advise against connecting an agent to production at all.{' '}
              <Cited claims={NOTES.readOnly!} />
            </p>
          </Part>

          <Part id="changes" title="When the agent changes something">
            <p className={READ}>
              Three questions: what stops a destructive call, who checks a schema change after it runs, and how you get
              back when one goes wrong.
            </p>
            {criteriaIn('changes').map((id) => (
              <Fragment key={id}>
                <Criterion id={id} />
                {id === 'destructive' && (
                  <p className={READ}>
                    <Cited claims={NOTES.destructive!} /> The rows above describe what each server does on its own,
                    whatever the client is set to allow.
                  </p>
                )}
              </Fragment>
            ))}
          </Part>

          <Part id="running" title="After the agent leaves">
            <p className={READ}>
              Most problems show up when no agent is connected. What differs is whether a fix waits for you or your
              agent to apply it, or the platform applies the safe ones itself.
            </p>
            {criteriaIn('running').map((id) => (
              <Criterion key={id} id={id} />
            ))}
          </Part>

          <Part id="platform" title="The platform underneath">
            <p className={READ}>The last three questions decide whether the backend suits your app, not only your agent.</p>
            {criteriaIn('platform').map((id) => (
              <Criterion key={id} id={id} />
            ))}
            <p className={READ}>Prices and limits change often. The pricing pages linked above have the current figures.</p>
          </Part>

          <Part id="other">
            <p className={READ}>
              Backenly is the wrong choice for some projects, starting with any where the agent has to work on a
              database you already run elsewhere: Backenly’s MCP server only operates a Backenly project. These are
              the other clear cases.
            </p>
            <GuideRows
              items={ALTERNATIVES.map((a) => (
                <>
                  <span className="text-white">{a.when}</span> <Cited claims={a.claims} />
                </>
              ))}
            />
          </Part>

          <Part id="method">
            <p className={READ}>
              Backenly wrote this guide, and Backenly is one of the seven options in it. So every row about another
              product restates that vendor’s own documentation, pricing page or repository, read on{' '}
              {guideDate(ACCESSED)}, and links it. Nothing comes from reviews, benchmarks or memory, and nothing is
              ranked: which backend suits you depends on which rows matter for your app.
            </p>
            <p className={READ}>
              “Not documented” means the linked pages do not say. It does not mean the product cannot do it, so check
              with the vendor before you rule something out.
            </p>
            <p className={READ}>
              Backenly’s rows link the code and docs in its public repository, and a test keeps them in line with that
              code: the tool counts, the refusal codes, the licences and the free plan. The same test fails if a claim
              about another product loses its source. Other backends were not checked; the nine questions apply to
              them too.
            </p>
            <p className={READ}>
              Products change faster than guides. If a row is out of date, tell us through the{' '}
              <Link href="/contact" className={PROSE_LINK}>
                contact page
              </Link>{' '}
              and it will be corrected.
            </p>
          </Part>

          <Part id="next">
            <NextLinks items={READ_NEXT.map((item) => ({ ...item }))} />
          </Part>
        </GuideDocument>
      </Page>
    </SiteShell>
  )
}
