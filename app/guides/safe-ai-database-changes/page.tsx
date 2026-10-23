import type { Metadata } from 'next'
import { DatabaseBackup } from 'lucide-react'
import type { ReactNode } from 'react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { pageMetadata, SITE_URL } from '@/lib/seo/metadata'
import { graph, ORGANIZATION_ID } from '@/lib/seo/schema'
import { SiteShell } from '@/components/site/SiteShell'
import { DataTable, JsonLd, NextLinks, Page, Steps } from '@/components/site/kit'
import {
  GuideCode as Code,
  GuideDocument,
  GuideMetaDivider,
  GuideRows,
  GuideSection,
  GuideSource as Source,
  GuideSourceLine,
  GuideSubHeading,
  GUIDE_TEXT,
  guideDate,
} from '@/components/site/guide'
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

   Set as a document, like the docs and legal pages: components/site/guide.tsx.
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

/** The sections, in order: the headings below and the "On this page" rail. */
const TOC: { id: string; label: string }[] = [
  { id: 'who', label: 'Who may do what' },
  { id: 'path', label: 'One change, step by step' },
  { id: 'checkpoints', label: 'Checkpoints' },
  { id: 'undo', label: 'Safe to reverse' },
  { id: 'case', label: 'In production' },
  { id: 'limits', label: 'What is not automated' },
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
      { '@type': 'ListItem', position: 2, name: 'Safe database changes', item: URL },
    ],
  },
)

const code = (text: string) => <Code>{text}</Code>

/** A section under its rail label, or a longer heading. */
function Part({ id, title, children }: { id: string; title?: string; children: ReactNode }) {
  return (
    <GuideSection id={id} title={title ?? TOC.find((item) => item.id === id)!.label}>
      {children}
    </GuideSection>
  )
}

export default function SafeChangesGuide() {
  return (
    <SiteShell>
      <JsonLd json={safeJsonLd(structuredData)} />
      <Page>
        <GuideDocument
          icon={DatabaseBackup}
          title={TITLE}
          crumb="Safe database changes"
          summary="A coding agent can write a correct migration and still lose data: by dropping something it did not know was in use, or by undoing a change after the app has written to it. This is how Backenly handles both, what it does on its own, and what it leaves to you."
          meta={
            <>
              <span>Updated {guideDate(GUIDE_UPDATED)}</span>
              <GuideMetaDivider />
              <span>Each section links the code it describes</span>
            </>
          }
          toc={TOC}
          close="One free project, no credit card. Connect your agent and ask it to change the schema."
        >
          <Part id="who">
            <p className={READ}>
              Three authorities, never mixed. The agent asks, Backenly checks and records, and a person decides
              anything Backenly cannot prove safe.
            </p>
            <DataTable
              caption="What a coding agent, Backenly and a person may each do with a schema change"
              columns={['Who', 'May', 'May not']}
              rows={AUTHORITIES.map((a) => [a.who, a.may, a.mayNot || '—'])}
            />
            <GuideSourceLine>
              Source: <Source href={SOURCES.recoveryDesign}>docs/CHANGE_RECOVERY.md</Source>
            </GuideSourceLine>
          </Part>

          <Part id="path">
            <p className={READ}>
              What happens between an agent calling {code('apply_migration')} and the change counting as done. The
              code is <Source href={SOURCES.migrationParser}>the migration parser</Source>,{' '}
              <Source href={SOURCES.ledger}>the change ledger</Source> and{' '}
              <Source href={SOURCES.verify}>protected verification</Source>.
            </p>
            <div className="mt-[8px]">
              <Steps steps={CHANGE_STEPS} />
            </div>
          </Part>

          <Part id="checkpoints" title="Checkpoints, sized to the risk">
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
          </Part>

          <Part id="undo" title="Reversible is not the same as safe to reverse">
            <p className={READ}>
              Putting the schema back is usually possible. Whether it is safe depends on what the application wrote
              since the change, so before any restore Backenly measures exactly that. A restore plan for “the state
              before change N” checks that every table the change touched still looks exactly as it left it, orders
              the reverse statements, measures the impact, and proves the statements in a transaction that is rolled
              back. The impact question is whether any data written since would stop being available to the app:
            </p>
            <GuideRows items={IMPACT_CASES} />
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
          </Part>

          <Part id="case" title="In production: consolidating a duplicated column">
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

            <GuideSubHeading>Undoing the switch restored the same bytes</GuideSubHeading>
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

            <GuideSubHeading>What it proved, and what it did not</GuideSubHeading>
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
            <GuideSourceLine>
              The full record, with plan and image ids:{' '}
              <Source href={SOURCES.acceptanceRecord}>docs/maintenance-production-acceptance.md</Source>. The ladder’s
              steps: <Source href={SOURCES.ladder}>lib/autonomy/maintenance/step.ts</Source>.
            </GuideSourceLine>

            <GuideSubHeading>Where it stands today</GuideSubHeading>
            <p className={READ}>
              The rule got stricter after this run. Since 21 September, Backenly schedules a ladder only if it can
              perform the undo of every step in the deployment it runs on, not merely describe one. The constraint step
              above has no undo yet, so this ladder is shown with that reason and not offered for approval until one
              exists. The restructuring offered today consolidates a table’s fragmented access policies, and its undo puts
              back the exact policy set that was there before. The rule is{' '}
              <Source href={SOURCES.rollbackCapability}>lib/autonomy/maintenance/rollback-capability.ts</Source>.
            </p>
          </Part>

          <Part id="limits">
            <GuideRows items={NOT_AUTOMATED} />
          </Part>

          <Part id="next">
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
          </Part>
        </GuideDocument>
      </Page>
    </SiteShell>
  )
}
