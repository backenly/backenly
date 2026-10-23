import type { Metadata } from 'next'
import { DatabaseBackup } from 'lucide-react'
import type { ReactNode } from 'react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { pageMetadata, SITE_URL } from '@/lib/seo/metadata'
import { graph, ORGANIZATION_ID } from '@/lib/seo/schema'
import { SiteShell } from '@/components/site/SiteShell'
import { ButtonLink, DataTable, JsonLd, NextLinks, Page, Steps, Trail } from '@/components/site/kit'
import { ScrollSpy } from '@/components/site/ScrollSpy'
import { StartButton } from '@/components/site/StartButton'
import { CONTAINER, DISPLAY, HEADING, PANEL, PROSE_LINK, TITLE as TITLE_TYPE } from '@/components/site/tokens'
import { ICON_CHIP, READ, ROW_RULE } from '@/components/docs/tokens'
import {
  AUTHORITIES,
  CHANGE_STEPS,
  CHECKPOINTS,
  GUIDE_PATH,
  GUIDE_UPDATED,
  IMPACT_CASES,
  LADDER_RUN,
  NOT_AUTOMATED,
  READER_HASHES,
  RECOVERY_SAFETY,
  SOURCES,
} from './content'

/* ─────────────────────────────────────────────────────────────
   /guides/safe-ai-database-changes

   One technical guide, written to be checked rather than believed: what
   happens to a schema change an agent makes, why "it can be undone" and "it
   is safe to undo" are different questions, and one production run of the
   expand/contract ladder with its evidence. Every section links the source
   it restates. The facts are ./content.ts, held to the code and the
   acceptance record by tests/unit/safe-changes-guide-conformance.spec.ts.

   Set as a document, the way the docs pages and the legal pages are
   (app/docs/[slug]/page.tsx, components/site/legal.tsx): the docs header
   (crumb, icon chip, gradient title, summary, meta line), the page at a
   reading measure, its sections under linkable headings with the docs' dot
   lists and hairline rows, and "On this page" following the scroll. There is
   no left column: a guide has no sibling pages to list yet.
───────────────────────────────────────────────────────────────────── */

const TITLE = 'Safe database changes with AI coding agents'
const DESCRIPTION =
  'How Backenly checkpoints, verifies and recovers the schema changes an AI agent makes, why some undos need a person, and a production run of a column consolidation.'

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: GUIDE_PATH,
  type: 'article',
  modifiedTime: GUIDE_UPDATED,
})

const URL = `${SITE_URL}${GUIDE_PATH}`

/** "October 24, 2026", the docs' date format (app/docs/content.ts DOCS_UPDATED). */
const UPDATED_DISPLAY = new Date(`${GUIDE_UPDATED}T00:00:00Z`).toLocaleDateString('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
})

/** The sections, in order: the headings below and the "On this page" rail. */
const TOC = [
  { id: 'who', label: 'Who may do what' },
  { id: 'path', label: 'One change, step by step' },
  { id: 'checkpoints', label: 'Checkpoints' },
  { id: 'undo', label: 'Safe to reverse' },
  { id: 'case', label: 'In production' },
  { id: 'limits', label: 'What is not automated' },
  { id: 'next', label: 'Read next' },
] as const

type SectionId = (typeof TOC)[number]['id']

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
      { '@type': 'ListItem', position: 2, name: 'Safe database changes', item: URL },
    ],
  },
)

const code = (text: string) => <code className="font-mono text-[13px] text-zinc-200">{text}</code>

function Source({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={PROSE_LINK}>
      {children}
    </a>
  )
}

/** The docs' list marker: a small dot on the first line of 15–16px copy. */
function Dot() {
  return <span aria-hidden className="mt-[11px] h-[4px] w-[4px] shrink-0 rounded-full bg-zinc-600" />
}

/** One section under the docs' linkable heading. The label is the rail's unless the heading says more. */
function GuideSection({ id, title, children }: { id: SectionId; title?: string; children: ReactNode }) {
  const label = title ?? TOC.find((item) => item.id === id)!.label
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-[100px]">
      <h2 id={`${id}-heading`} className={`group text-[23px] text-white md:text-[26px] ${TITLE_TYPE}`}>
        <a href={`#${id}`} className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300">
          {label}
          <span aria-hidden className="ml-[8px] text-zinc-600 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            #
          </span>
        </a>
      </h2>
      <div className="mt-[20px] flex flex-col gap-[20px]">{children}</div>
    </section>
  )
}

/** A sub-heading inside a section. */
function SubHeading({ children }: { children: ReactNode }) {
  return <h3 className={`mt-[12px] text-[17px] text-white ${HEADING}`}>{children}</h3>
}

/** The docs' "Good to know" rows: a dot, a hairline under each. */
function Rows({ items }: { items: readonly string[] }) {
  return (
    <ul className={`border-t ${ROW_RULE}`}>
      {items.map((item) => (
        <li key={item} className={`flex gap-[12px] border-b py-[16px] ${ROW_RULE}`}>
          <Dot />
          <span className={`min-w-0 ${READ}`}>{item}</span>
        </li>
      ))}
    </ul>
  )
}

/** A source line under a table or a passage. */
function SourceLine({ children }: { children: ReactNode }) {
  return <p className="text-[14px] leading-[1.65] text-zinc-400">{children}</p>
}

export default function SafeChangesGuide() {
  return (
    <SiteShell>
      <JsonLd json={safeJsonLd(structuredData)} />
      <Page>
        {/* Key light, as on every page, behind the title. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -top-[260px] left-[-12%] h-[820px] w-[1100px] max-w-none bg-[radial-gradient(closest-side,rgba(255,255,255,0.06),transparent)]"
        />

        <div className={`${CONTAINER} relative pb-[120px] pt-[28px] md:pt-[48px]`}>
          <div className="grid gap-[40px] xl:grid-cols-[minmax(0,760px)_200px] xl:justify-between">
            <article className="min-w-0 max-w-[760px] lg:pt-[4px]">
              <header className={`hero-enter border-b pb-[36px] ${ROW_RULE}`}>
                <Trail
                  readable
                  items={[
                    { label: 'Home', href: '/' },
                    // Not a link: there is no guides index yet.
                    { label: 'Guides' },
                    { label: 'Safe database changes' },
                  ]}
                />
                <div className="mt-[28px] flex items-center gap-[14px]">
                  <span className={`h-[44px] w-[44px] rounded-[8px] text-zinc-200 ${ICON_CHIP}`}>
                    <DatabaseBackup aria-hidden strokeWidth={1.75} className="h-[20px] w-[20px]" />
                  </span>
                  <h1
                    className={`min-w-0 bg-gradient-to-b from-white from-40% to-zinc-400 bg-clip-text pb-[4px] text-[34px] text-transparent sm:text-[40px] md:text-[46px] ${DISPLAY}`}
                  >
                    {TITLE}
                  </h1>
                </div>
                <p className="mt-[20px] max-w-[64ch] text-[17px] leading-[1.65] tracking-[-0.012em] text-zinc-400 [text-wrap:pretty] md:text-[18px]">
                  A coding agent can write a correct migration and still lose data: by dropping something it did not know
                  was in use, or by undoing a change after the app has written to it. This is how Backenly handles both,
                  what it does on its own, and what it leaves to you.
                </p>
                <p className="mt-[20px] flex flex-wrap items-center gap-x-[12px] gap-y-[4px] text-[13px] text-zinc-400">
                  <span>Updated {UPDATED_DISPLAY}</span>
                  <span aria-hidden className="hidden h-[12px] w-px bg-white/[0.12] sm:block" />
                  <span>Each section links the code it describes</span>
                </p>
              </header>

              <div className="mt-[48px] flex flex-col gap-[64px]">
                <GuideSection id="who">
                  <p className={READ}>
                    Three authorities, never mixed. The agent asks, Backenly checks and records, and a person decides
                    anything Backenly cannot prove safe.
                  </p>
                  <DataTable
                    caption="What a coding agent, Backenly and a person may each do with a schema change"
                    columns={['Who', 'May', 'May not']}
                    rows={AUTHORITIES.map((a) => [a.who, a.may, a.mayNot || '—'])}
                  />
                  <SourceLine>
                    Source: <Source href={SOURCES.recoveryDesign}>docs/CHANGE_RECOVERY.md</Source>
                  </SourceLine>
                </GuideSection>

                <GuideSection id="path">
                  <p className={READ}>
                    What happens between an agent calling {code('apply_migration')} and the change counting as done. The
                    code is <Source href={SOURCES.migrationParser}>the migration parser</Source>,{' '}
                    <Source href={SOURCES.ledger}>the change ledger</Source> and{' '}
                    <Source href={SOURCES.verify}>protected verification</Source>.
                  </p>
                  <div className="mt-[8px]">
                    <Steps steps={CHANGE_STEPS} />
                  </div>
                </GuideSection>

                <GuideSection id="checkpoints" title="Checkpoints, sized to the risk">
                  <p className={READ}>
                    Nothing a change removes is deleted. A dropped table or column moves into the change’s vault in the same
                    transaction (<Source href={SOURCES.preserve}>lib/changes/preserve.ts</Source>), and a destructive change
                    runs only after a person approves it.
                  </p>
                  <DataTable
                    caption="What Backenly keeps before a schema change, by the change's risk"
                    columns={['Risk', 'For example', 'What is kept']}
                    rows={CHECKPOINTS.map((c) => [c.risk, c.example, c.protection])}
                  />
                </GuideSection>

                <GuideSection id="undo" title="Reversible is not the same as safe to reverse">
                  <p className={READ}>
                    Putting the schema back is usually possible. Whether it is safe depends on what the application wrote
                    since the change, so before any restore Backenly measures exactly that. A restore plan for “the state
                    before change N” checks that every table the change touched still looks exactly as it left it, orders
                    the reverse statements, measures the impact, and proves the statements in a transaction that is rolled
                    back. The impact question is whether any data written since would stop being available to the app:
                  </p>
                  <Rows items={IMPACT_CASES} />
                  <p className={READ}>
                    Any impact at all makes the plan need a person, even though what would leave the app is kept in the
                    restore’s own vault: kept is not the same as available. When the restore runs, Backenly locks the tables,
                    measures again, and refuses if the impact is worse than what the person approved. The code is{' '}
                    <Source href={SOURCES.recovery}>lib/changes/recovery.ts</Source>.
                  </p>
                  <DataTable
                    caption="Restore plan outcomes and who may run each"
                    columns={['Plan', 'Meaning', 'Who may run it']}
                    codeFirstColumn
                    rows={RECOVERY_SAFETY.map((r) => [r.safety, r.meaning, r.who])}
                  />
                  <p className={READ}>
                    Automatic recovery is the {code('lossless')} row only, and only right after a change failed its
                    verification. A recovery that fails stops: no retries, the evidence stays, and a person decides. While
                    any change in the project waits for a person, Backenly takes no further automatic recovery action there.
                  </p>
                </GuideSection>

                <GuideSection id="case" title="In production: consolidating a duplicated column">
                  <p className={READ}>
                    Restructuring a live table is risky because the app keeps reading and writing it while the change runs.
                    Backenly does it as an expand/contract ladder of separately reversible steps, and only with the owner’s
                    consent, bound to the exact plan. On 16 September 2026 the ladder ran against a disposable project on
                    Backenly’s production database. The table had {code('sessions.status')} and a duplicate,{' '}
                    {code('sessions.legacy_state')}, over 80 rows; the ladder consolidated them onto a new{' '}
                    {code('lifecycle_state')}.
                  </p>
                  <DataTable
                    caption="Each step of the production run and its recorded outcome"
                    columns={['Step', 'Recorded outcome']}
                    codeFirstColumn
                    rows={LADDER_RUN.map((r) => [r.rung, r.outcome])}
                  />

                  <SubHeading>Undoing the switch restored the same bytes</SubHeading>
                  <p className={READ}>
                    Switching readers rewrites the functions that read the old column. Reverting put back the code recorded
                    in the ledger, not regenerated code that happens to behave the same:
                  </p>
                  <DataTable
                    caption="Hash of the reader function's code before the switch, after it, and after the revert"
                    columns={['Point', 'Code hash', 'Reads']}
                    minWidth="min-w-[420px]"
                    rows={READER_HASHES.map((r) => [r.point, code(r.hash), code(r.reads)])}
                  />

                  <SubHeading>What it proved, and what it did not</SubHeading>
                  <p className={READ}>
                    It proved the execution path: every gate, the background backfill, the reader switch and its revert. It
                    was not evidence about detection, since the finding was created for the exercise and labelled as such.
                    Consent behaved as designed: each step changed the catalog, which changed the plan version, and an
                    approval for the old version stopped applying.
                  </p>
                  <p className={READ}>
                    Three classes of consumer, such as clients that query the API or the database directly, cannot be
                    enumerated, so they still read the old column. That is why the last step, dropping it, is always a
                    person’s. The run also found seven silent defects, from a redaction regex that stopped working to five
                    reads blind to row-level security, each caught by a gate or by a report contradicting itself.
                  </p>
                  <SourceLine>
                    The full record, with plan and image ids:{' '}
                    <Source href={SOURCES.acceptanceRecord}>docs/maintenance-production-acceptance.md</Source>. The ladder’s
                    steps: <Source href={SOURCES.ladder}>lib/autonomy/maintenance/step.ts</Source>.
                  </SourceLine>
                </GuideSection>

                <GuideSection id="limits">
                  <Rows items={NOT_AUTOMATED} />
                </GuideSection>

                <GuideSection id="next">
                  <NextLinks
                    items={[
                      {
                        href: '/mcp',
                        meta: 'MCP server',
                        title: 'What your agent can call',
                        body: 'The tools, the install for each client, and what waits for you.',
                      },
                      {
                        href: '/docs/database',
                        meta: 'Docs',
                        title: 'Database',
                        body: 'Tables, the REST API and row-level security.',
                      },
                      {
                        href: '/docs/autonomy',
                        meta: 'Docs',
                        title: 'Autonomy',
                        body: 'What Backenly fixes on its own, and what waits for your approval.',
                      },
                    ]}
                  />
                </GuideSection>
              </div>

              {/* The docs' closing panel shape (components/site/legal.tsx LegalContact), with the ask. */}
              <div
                className={`mt-[72px] flex flex-col gap-[20px] p-[20px] md:flex-row md:items-center md:justify-between md:p-[24px] ${PANEL}`}
              >
                <div className="min-w-0">
                  <p className={`text-[16px] text-white ${HEADING}`}>Try it on a live project</p>
                  <p className="mt-[6px] max-w-[52ch] text-[15px] leading-[1.65] text-zinc-400 [text-wrap:pretty]">
                    One free project, no credit card. Connect your agent and ask it to change the schema.
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-[10px]">
                  <StartButton />
                  <ButtonLink href="/docs/connect" variant="secondary">
                    Connect your agent
                  </ButtonLink>
                </div>
              </div>
            </article>

            <aside className="hidden xl:block">
              <div className="sticky top-[100px] pt-[4px]">
                <p className="mb-[12px] text-[13px] font-medium text-zinc-400">On this page</p>
                <ScrollSpy label="On this page" items={[...TOC]} readable />
              </div>
            </aside>
          </div>
        </div>
      </Page>
    </SiteShell>
  )
}
