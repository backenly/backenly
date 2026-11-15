import type { Metadata } from 'next'
import { ArrowUpRight, Rss } from 'lucide-react'
import { pageMetadata } from '@/lib/seo/metadata'
import { SiteShell } from '@/components/site/SiteShell'
import { Page, PageHero } from '@/components/site/kit'
import { CONTAINER, SECONDARY_CTA } from '@/components/site/tokens'
import { Light, type BoxLight } from '@/components/landing-v8/Box'
import { ChangelogFeed } from '@/components/changelog/ChangelogFeed'
import { CopyLink } from '@/components/changelog/CopyLink'
import { HighlightVisual } from '@/components/changelog/HighlightVisual'
import {
  CHANGELOG,
  CHANGELOG_UPDATED,
  areaCounts,
  areaSlug,
  entrySlug,
  type ChangelogEntry,
  type ChangelogHighlight,
  type ChangelogKind,
} from './entries'

/* ─────────────────────────────────────────────────────────────
   /changelog (founders, 2026-11-15: "add a changelog ... from the august
   onwards ... non ai slop", then "more professional, like how our
   competitors and devtools do").

   Each month opens with its largest changes as cards, each with the one
   picture that is true of it (components/changelog/HighlightVisual), and the
   rest follow on a timeline: the date, whether it is new, improved or fixed,
   the area, a plain title and a sentence or two, the public pull requests,
   and a link to the change itself. A rail keeps the months and the areas in
   view; the RSS feed is at /changelog/rss.xml. The words live in ./entries.ts.
───────────────────────────────────────────────────────────── */

const REPO = 'https://github.com/backenly/backenly'

const base = pageMetadata({
  title: 'Changelog: what changed, month by month',
  description:
    'What changed in Backenly, month by month: autonomy, the database, auth, storage, functions, the MCP server for coding agents, the console and self-hosting.',
  path: '/changelog',
  modifiedTime: CHANGELOG_UPDATED,
})

export const metadata: Metadata = {
  ...base,
  alternates: { ...base.alternates, types: { 'application/rss+xml': [{ url: '/changelog/rss.xml', title: 'Backenly changelog' }] } },
}

function monthName(month: string) {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

function dayName(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** Text with `backticked` names set as code. */
function Prose({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) =>
        i % 2 ? (
          <code key={i} className="rounded-[4px] bg-white/[0.06] px-[5px] py-[1px] font-mono text-[0.88em] text-zinc-200">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  )
}

/** New, improved or fixed: one small mark, the same on the timeline and in the label. */
const KIND_DOT: Record<ChangelogKind, string> = {
  New: 'bg-violet-300',
  Improved: 'bg-zinc-300',
  Fixed: 'border border-zinc-300 bg-[#08090a]',
}

function Kind({ kind }: { kind: ChangelogKind }) {
  return (
    <span className="inline-flex h-[22px] items-center gap-[6px] rounded-[6px] border border-white/[0.10] bg-white/[0.03] px-[8px] text-[12.5px] font-medium text-zinc-200">
      <span aria-hidden className={`h-[6px] w-[6px] rounded-full ${KIND_DOT[kind]}`} />
      {kind}
    </span>
  )
}

function Meta({ entry, slug }: { entry: ChangelogEntry; slug: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-[10px] gap-y-[6px] text-[13.5px] text-zinc-400">
      <time dateTime={entry.date} className="tabular-nums">
        {dayName(entry.date)}
      </time>
      <Kind kind={entry.kind} />
      <span>{entry.area}</span>
      <span className="ml-auto">
        <CopyLink slug={slug} title={entry.title} />
      </span>
    </div>
  )
}

function Prs({ prs }: { prs?: number[] }) {
  if (!prs || prs.length === 0) return null
  return (
    <p className="mt-[12px] flex flex-wrap gap-x-[12px] gap-y-[4px] font-mono text-[12.5px]">
      {prs.map((n) => (
        <a
          key={n}
          href={`${REPO}/pull/${n}`}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-[3px] text-zinc-400 underline decoration-white/15 underline-offset-[3px] transition-colors hover:text-white hover:decoration-white/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          #{n}
          <span className="sr-only"> on GitHub (opens in a new tab)</span>
        </a>
      ))}
    </p>
  )
}

/** Each highlight's light, so neighbouring cards lean different ways; all kept low. */
const CARD_LIGHT: Record<ChangelogHighlight, BoxLight> = {
  session: { art: 'a' },
  repair: { art: 'c', flip: true },
  restructure: { art: 'a', flip: true },
  history: { art: 'b' },
  selfhost: { art: 'c' },
  cadence: { art: 'b', flip: true },
}

/** The landing's figures are wide; code and the cadence sit beside the words. */
const WIDE: ChangelogHighlight[] = ['repair', 'restructure', 'history']

function Highlight({ entry }: { entry: ChangelogEntry & { highlight: ChangelogHighlight } }) {
  const slug = entrySlug(entry)
  const wide = WIDE.includes(entry.highlight)
  return (
    <article
      id={slug}
      data-cl-area={areaSlug(entry.area)}
      aria-labelledby={`${slug}-title`}
      className="group/entry relative isolate scroll-mt-[96px] overflow-hidden rounded-[10px] border border-white/[0.10] bg-[#0b0c0f]"
    >
      <Light
        {...CARD_LIGHT[entry.highlight]}
        reach={360}
        strength={0.32}
        mask="linear-gradient(to bottom, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.35) 50%, transparent 100%)"
      />
      <div className={wide ? '' : 'lg:grid lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:items-center'}>
        <div className="p-[24px] sm:p-[32px]">
          <Meta entry={entry} slug={slug} />
          <h3
            id={`${slug}-title`}
            className="mt-[16px] text-[24px] font-normal leading-[1.15] tracking-[-0.03em] text-white [text-wrap:balance] sm:text-[28px]"
          >
            {entry.title}
          </h3>
          <p className="mt-[12px] max-w-[62ch] text-[16px] leading-[1.65] text-zinc-300 [text-wrap:pretty]">
            <Prose text={entry.body} />
          </p>
          <Prs prs={entry.prs} />
        </div>
        <div
          className={
            wide
              ? 'border-t border-white/[0.07] px-[12px] pb-[12px] pt-[4px] sm:px-[24px] sm:pb-[24px]'
              : 'min-w-0 px-[24px] pb-[24px] sm:px-[32px] sm:pb-[32px] lg:py-[32px] lg:pl-0'
          }
        >
          <HighlightVisual name={entry.highlight} />
        </div>
      </div>
    </article>
  )
}

function Row({ entry }: { entry: ChangelogEntry }) {
  const slug = entrySlug(entry)
  return (
    <article
      id={slug}
      data-cl-area={areaSlug(entry.area)}
      aria-labelledby={`${slug}-title`}
      className="group/entry relative scroll-mt-[96px] py-[24px] pl-[32px]"
    >
      <span
        aria-hidden
        className={`absolute left-0 top-[31px] h-[9px] w-[9px] rounded-full shadow-[0_0_0_4px_#08090a] ${KIND_DOT[entry.kind]}`}
      />
      <Meta entry={entry} slug={slug} />
      <h3 id={`${slug}-title`} className="mt-[10px] text-[18px] font-medium leading-[1.35] tracking-[-0.012em] text-white [text-wrap:pretty]">
        {entry.title}
      </h3>
      <p className="mt-[6px] max-w-[68ch] text-[15.5px] leading-[1.65] text-zinc-300 [text-wrap:pretty]">
        <Prose text={entry.body} />
      </p>
      <Prs prs={entry.prs} />
    </article>
  )
}

function summary(entries: ChangelogEntry[]) {
  const n = (k: ChangelogKind) => entries.filter((e) => e.kind === k).length
  const parts = [`${n('New')} new`, `${n('Improved')} improved`, `${n('Fixed')} fixed`].filter((p) => !p.startsWith('0 '))
  return `${entries.length} changes: ${parts.join(', ')}`
}

export default function ChangelogPage() {
  const areas = areaCounts()
  const total = CHANGELOG.reduce((sum, m) => sum + m.entries.length, 0)
  const months = CHANGELOG.map((m) => ({ id: m.month, label: monthName(m.month), count: m.entries.length }))

  // The area filter is CSS: the rail sets data-cl-filter, and these rules hide what does not match.
  const filterRules = [
    '[data-cl-filter]:not([data-cl-filter="all"]) [data-cl-also],[data-cl-filter]:not([data-cl-filter="all"]) [data-cl-summary]{display:none}',
    ...areas.map(
      ({ slug }) =>
        `[data-cl-filter="${slug}"] [data-cl-area]:not([data-cl-area="${slug}"]),[data-cl-filter="${slug}"] [data-cl-month]:not([data-cl-areas~="${slug}"]){display:none}`,
    ),
  ].join('\n')

  return (
    <SiteShell>
      <style>{filterRules}</style>
      <Page>
        <PageHero
          trail={[{ label: 'Home', href: '/' }, { label: 'Changelog' }]}
          title="Changelog"
          lede="What changed in Backenly, newest first. Where the code is open, each change links to the pull requests behind it."
          light={{ art: 'b', reach: 560, strength: 0.5 }}
          rule={false}
          actions={
            <>
              <a href="/changelog/rss.xml" className={SECONDARY_CTA}>
                <Rss aria-hidden className="h-[16px] w-[16px]" />
                RSS feed
              </a>
              <a href="https://x.com/Backenly" target="_blank" rel="noopener noreferrer" className={SECONDARY_CTA}>
                Follow on X
                <ArrowUpRight aria-hidden className="h-[16px] w-[16px]" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </>
          }
        />

        <div className={`${CONTAINER} pb-[120px] pt-[8px] md:pb-[160px] md:pt-[16px]`}>
          <ChangelogFeed months={months} areas={areas} total={total}>
            {CHANGELOG.map(({ month, entries, also }) => {
              const highlights = entries.filter((e): e is ChangelogEntry & { highlight: ChangelogHighlight } => !!e.highlight)
              const rest = entries.filter((e) => !e.highlight)
              const monthAreas = [...new Set(entries.map((e) => areaSlug(e.area)))].join(' ')
              return (
                <section
                  key={month}
                  id={month}
                  data-cl-month=""
                  data-cl-areas={monthAreas}
                  aria-labelledby={`${month}-title`}
                  className="scroll-mt-[96px] border-t border-white/[0.10] pb-[48px] pt-[40px] first:border-t-0 first:pt-[4px] md:pt-[48px]"
                >
                  <header className="flex flex-wrap items-baseline justify-between gap-x-[24px] gap-y-[6px]">
                    <h2 id={`${month}-title`} className="text-[30px] font-normal tracking-[-0.03em] text-white md:text-[36px]">
                      {monthName(month)}
                    </h2>
                    <p data-cl-summary="" className="text-[14px] text-zinc-400">
                      {summary(entries)}
                    </p>
                  </header>

                  {highlights.length > 0 && (
                    <div className="mt-[28px] grid gap-[20px]">
                      {highlights.map((entry) => (
                        <Highlight key={entrySlug(entry)} entry={entry} />
                      ))}
                    </div>
                  )}

                  <div className="relative mt-[12px] before:absolute before:bottom-[28px] before:left-[4px] before:top-[36px] before:w-px before:bg-white/[0.08]">
                    {rest.map((entry) => (
                      <Row key={entrySlug(entry)} entry={entry} />
                    ))}
                  </div>

                  {also && also.length > 0 && (
                    <div data-cl-also="" className="mt-[12px] rounded-[10px] border border-white/[0.07] bg-white/[0.02] px-[20px] py-[18px] sm:px-[24px]">
                      <h3 className="text-[14.5px] font-medium text-zinc-200">Also this month</h3>
                      <ul className="mt-[10px] grid gap-[8px]">
                        {also.map((line) => (
                          <li key={line} className="flex gap-[12px] text-[14.5px] leading-[1.6] text-zinc-400">
                            <span aria-hidden className="mt-[10px] h-[4px] w-[4px] shrink-0 rounded-full bg-zinc-500" />
                            <span className="min-w-0">
                              <Prose text={line} />
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </section>
              )
            })}
          </ChangelogFeed>
        </div>
      </Page>
    </SiteShell>
  )
}
