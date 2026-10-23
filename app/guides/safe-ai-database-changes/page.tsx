import type { Metadata } from 'next'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { pageMetadata, SITE_URL } from '@/lib/seo/metadata'
import { graph, ORGANIZATION_ID } from '@/lib/seo/schema'
import { SiteShell } from '@/components/site/SiteShell'
import {
  ButtonLink,
  DataTable,
  HorizonClose,
  JsonLd,
  NextLinks,
  Page,
  PageHero,
  Prose,
  Section,
  SectionHead,
  Steps,
} from '@/components/site/kit'
import { StartButton } from '@/components/site/StartButton'
import { PROSE_LINK } from '@/components/site/tokens'
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

function Source({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={PROSE_LINK}>
      {children}
    </a>
  )
}

export default function SafeChangesGuide() {
  return (
    <SiteShell>
      <JsonLd json={safeJsonLd(structuredData)} />
      <Page>
        <PageHero
          trail={[{ label: 'Home', href: '/' }, { label: 'Safe database changes' }]}
          title={TITLE}
          lede="A coding agent can write a correct migration and still lose data: by dropping something it did not know was in use, or by undoing a change after the app has written to it. This is how Backenly handles both, what it does on its own, and what it leaves to you."
          actions={
            <>
              <StartButton />
              <ButtonLink href="/mcp" variant="secondary">
                The MCP server
              </ButtonLink>
            </>
          }
        />

        <Section flush aria-labelledby="who">
          <SectionHead
            id="who"
            size="sm"
            title="Who may do what"
            lede="Three authorities, never mixed. The agent asks, Backenly checks and records, and a person decides anything Backenly cannot prove safe."
          />
          <div className="mt-[40px]">
            <DataTable
              caption="What a coding agent, Backenly and a person may each do with a schema change"
              columns={['Who', 'May', 'May not']}
              rows={AUTHORITIES.map((a) => [a.who, a.may, a.mayNot || '—'])}
            />
          </div>
          <Prose className="mt-[20px] text-[14px]">
            Source: <Source href={SOURCES.recoveryDesign}>docs/CHANGE_RECOVERY.md</Source>
          </Prose>
        </Section>

        <Section aria-labelledby="path">
          <div className="grid gap-[40px] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-[64px]">
            <SectionHead
              id="path"
              size="sm"
              title="One change, step by step"
              lede={
                <>
                  What happens between an agent calling {code('apply_migration')} and the change counting as done. The
                  code is <Source href={SOURCES.migrationParser}>the migration parser</Source>,{' '}
                  <Source href={SOURCES.ledger}>the change ledger</Source> and{' '}
                  <Source href={SOURCES.verify}>protected verification</Source>.
                </>
              }
            />
            <Steps steps={CHANGE_STEPS} />
          </div>
        </Section>

        <Section aria-labelledby="checkpoints">
          <SectionHead
            id="checkpoints"
            size="sm"
            title="Checkpoints, sized to the risk"
            lede={
              <>
                Nothing a change removes is deleted. A dropped table or column moves into the change’s vault in the same
                transaction (<Source href={SOURCES.preserve}>lib/changes/preserve.ts</Source>), and a destructive change
                runs only after a person approves it.
              </>
            }
          />
          <div className="mt-[40px]">
            <DataTable
              caption="What Backenly keeps before a schema change, by the change's risk"
              columns={['Risk', 'For example', 'What is kept']}
              rows={CHECKPOINTS.map((c) => [c.risk, c.example, c.protection])}
            />
          </div>
        </Section>

        <Section aria-labelledby="undo">
          <SectionHead
            id="undo"
            size="sm"
            title="Reversible is not the same as safe to reverse"
            lede="Putting the schema back is usually possible. Whether it is safe depends on what the application wrote since the change. Before any restore, Backenly measures exactly that."
          />
          <div className="mt-[40px] grid gap-[40px] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-[64px]">
            <div className="flex flex-col gap-[16px]">
              <Prose>
                A restore plan for “the state before change N” checks that every table the change touched still looks
                exactly as it left it, orders the reverse statements, measures the impact, and proves the statements in a
                transaction that is rolled back. The impact question is whether any data written since would stop being
                available to the app:
              </Prose>
              <ul className="flex flex-col gap-[8px] pl-[18px] text-[15px] leading-[1.7] text-zinc-400 [list-style:disc]">
                {IMPACT_CASES.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <Prose>
                Any impact at all makes the plan need a person, even though what would leave the app is kept in the
                restore’s own vault: kept is not the same as available. When the restore runs, Backenly locks the tables,
                measures again, and refuses if the impact is worse than what the person approved. The code is{' '}
                <Source href={SOURCES.recovery}>lib/changes/recovery.ts</Source>.
              </Prose>
            </div>
            <DataTable
              caption="Restore plan outcomes and who may run each"
              columns={['Plan', 'Meaning', 'Who may run it']}
              codeFirstColumn
              minWidth="min-w-[520px]"
              rows={RECOVERY_SAFETY.map((r) => [r.safety, r.meaning, r.who])}
            />
          </div>
          <Prose className="mt-[32px]">
            Automatic recovery is the {code('lossless')} row only, and only right after a change failed its verification.
            A recovery that fails stops: no retries, the evidence stays, and a person decides. While any change in the
            project waits for a person, Backenly takes no further automatic recovery action there.
          </Prose>
        </Section>

        <Section aria-labelledby="case">
          <SectionHead
            id="case"
            size="sm"
            title="In production: consolidating a duplicated column"
            lede={
              <>
                Restructuring a live table is risky because the app keeps reading and writing it while the change runs. Backenly does it
                as an expand/contract ladder of separately reversible steps, and only with the owner’s consent, bound to the
                exact plan. On 16 September 2026 the ladder ran against a disposable project on Backenly’s production
                database. The table had {code('sessions.status')} and a duplicate, {code('sessions.legacy_state')}, over 80
                rows; the ladder consolidated them onto a new {code('lifecycle_state')}.
              </>
            }
          />
          <div className="mt-[40px]">
            <DataTable
              caption="Each step of the production run and its recorded outcome"
              columns={['Step', 'Recorded outcome']}
              codeFirstColumn
              rows={LADDER_RUN.map((r) => [r.rung, r.outcome])}
            />
          </div>
          <div className="mt-[40px] grid gap-[40px] lg:grid-cols-2 lg:gap-[64px]">
            <div className="flex flex-col gap-[16px]">
              <h3 className="text-[17px] font-semibold text-white">Undoing the switch restored the same bytes</h3>
              <Prose>
                Switching readers rewrites the functions that read the old column. Reverting put back the code recorded in
                the ledger, not regenerated code that happens to behave the same:
              </Prose>
              <DataTable
                caption="Hash of the reader function's code before the switch, after it, and after the revert"
                columns={['Point', 'Code hash', 'Reads']}
                minWidth="min-w-[420px]"
                rows={READER_HASHES.map((r) => [r.point, code(r.hash), code(r.reads)])}
              />
            </div>
            <div className="flex flex-col gap-[16px]">
              <h3 className="text-[17px] font-semibold text-white">What it proved, and what it did not</h3>
              <Prose>
                It proved the execution path: every gate, the background backfill, the reader switch and its revert. It was
                not evidence about detection, since the finding was created for the exercise and labelled as such. Consent
                behaved as designed: each step changed the catalog, which changed the plan version, and an approval for the
                old version stopped applying.
              </Prose>
              <Prose>
                Three classes of consumer, such as clients that query the API or the database directly, cannot be
                enumerated, so they still read the old column. That is why the last step, dropping it, is always a
                person’s. The run also found seven silent defects, from a redaction regex that stopped working to five reads
                blind to row-level security, each caught by a gate or by a report contradicting itself.
              </Prose>
              <Prose className="text-[14px]">
                The full record, with plan and image ids:{' '}
                <Source href={SOURCES.acceptanceRecord}>docs/maintenance-production-acceptance.md</Source>. The ladder’s
                steps: <Source href={SOURCES.ladder}>lib/autonomy/maintenance/step.ts</Source>.
              </Prose>
            </div>
          </div>
        </Section>

        <Section aria-labelledby="limits">
          <SectionHead id="limits" size="sm" title="What is not automated" />
          <ul className="mt-[32px] grid gap-[12px] md:grid-cols-2">
            {NOT_AUTOMATED.map((item) => (
              <li key={item} className="rounded-[10px] border border-white/[0.08] bg-white/[0.02] p-[20px] text-[15px] leading-[1.7] text-zinc-400">
                {item}
              </li>
            ))}
          </ul>
        </Section>

        <Section aria-labelledby="guide-next">
          <SectionHead id="guide-next" size="sm" title="Go further" />
          <NextLinks
            className="mt-[32px]"
            items={[
              { href: '/mcp', title: 'The MCP server and what waits for you' },
              { href: '/docs/database', title: 'Database: how a change is applied' },
              { href: '/docs/autonomy', title: 'Autonomy: the maintenance loop' },
            ]}
          />
        </Section>

        <HorizonClose title="Try it on a live project" lede="One free project, no credit card.">
          <StartButton />
          <ButtonLink href="/docs/connect" variant="secondary">
            Connect your agent
          </ButtonLink>
        </HorizonClose>
      </Page>
    </SiteShell>
  )
}
