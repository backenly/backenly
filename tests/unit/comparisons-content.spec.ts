/**
 * Comparisons and Alternatives — structure, balance, sourcing, and semantics.
 *
 * These two surfaces had no test of any kind before this file. The failures
 * they actually shipped were not exotic: a hero proof tile that read
 * "No-Code Builders — Manual setup" because the tile set was hardcoded across
 * every slug, a link to a use-case page that had been retired months earlier, a
 * support commitment ("the team helps with complex migrations") that no plan
 * entitles anyone to, and a comparison table whose scroll container no keyboard
 * user could reach.
 *
 * Most of those are judgement calls. The ones below are not, and they are the
 * ones that rot quietly.
 *
 * The balance assertions are the point of the file. A comparison page that
 * cannot say why a reader should choose the OTHER product is an advertisement,
 * and that is checkable. What is NOT checkable is whether the stated strengths
 * are any good, so this file deliberately does not try — it asserts they exist
 * and that the rule is real, and leaves quality to review.
 *
 * There is no banned-phrase list here, for the reason recorded in
 * scripts/verify-content-integrity.ts: one was tried, it rejected eight
 * accurate sentences, and failing a build on prose style is the wrong trade.
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

/**
 * SiteShell pulls in the smooth-scroll wrapper, which imports Lenis as ESM.
 * Jest does not transform it, so requiring a page module for its metadata
 * exports would fail on a dependency none of these assertions care about.
 * Stubbing the shell keeps the failure surface on the pages themselves rather
 * than widening jest.config for every other suite.
 */
jest.mock('@/components/site/SiteShell', () => ({
  SiteShell: ({ children }: { children: unknown }) => children,
}))
import { COMPARISONS, COMPARISON_LIST, COMPARISON_SLUGS } from '@/app/comparisons/data'
import {
  CRITERIA,
  DO_NOT_SWITCH,
  FAQ as ALT_FAQ,
  NOT_FOR,
  SWITCHING_COSTS,
} from '@/app/alternatives/data'
import { ComparisonTable, SplitDecision } from '@/components/site/kit'
import sitemap from '@/app/sitemap'

const APP_URL = 'https://backenly.com'

describe('the comparison set', () => {
  it('has the four routes and no duplicates', () => {
    expect(COMPARISON_SLUGS).toEqual([
      'backenly-vs-supabase',
      'backenly-vs-firebase',
      'backenly-vs-no-code-builders',
      'backenly-vs-traditional-backend-development',
    ])
    expect(new Set(COMPARISON_SLUGS).size).toBe(COMPARISON_SLUGS.length)
    expect(Object.keys(COMPARISONS)).toHaveLength(COMPARISON_LIST.length)
  })

  it.each(COMPARISON_LIST.map((c) => [c.slug, c] as const))(
    '%s concedes a real case for the competitor',
    (_slug, c) => {
      // The honesty invariant. Both halves matter: strengths explain WHY, and
      // the "choose them when" list turns it into a recommendation.
      expect(c.competitorStrengths.length).toBeGreaterThanOrEqual(2)
      expect(c.chooseCompetitorWhen.length).toBeGreaterThanOrEqual(1)
      for (const s of c.competitorStrengths) {
        expect(s.title.trim()).not.toHaveLength(0)
        expect(s.body.trim().length).toBeGreaterThan(40)
      }
    },
  )

  it.each(COMPARISON_LIST.map((c) => [c.slug, c] as const))(
    '%s has a complete capability table',
    (_slug, c) => {
      expect(c.table.length).toBeGreaterThanOrEqual(4)
      for (const row of c.table) {
        // The fourth column is why these are not tick-versus-cross. An empty one
        // silently reverts the format it replaced.
        expect(row.aspect.trim()).not.toHaveLength(0)
        expect(row.competitor.trim()).not.toHaveLength(0)
        expect(row.backenly.trim()).not.toHaveLength(0)
        expect(row.practical.trim()).not.toHaveLength(0)
      }
      const aspects = c.table.map((r) => r.aspect)
      expect(new Set(aspects).size).toBe(aspects.length)
    },
  )

  it.each(COMPARISON_LIST.map((c) => [c.slug, c] as const))(
    '%s sources every externally checkable competitor fact',
    (_slug, c) => {
      for (const fact of c.facts) {
        expect(fact.source).toMatch(/^https:\/\//)
        expect(fact.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(Number.isNaN(new Date(fact.verifiedOn).getTime())).toBe(false)
        expect(fact.claim.trim().length).toBeGreaterThan(20)
      }
    },
  )

  it('sources the two comparisons that make hard external claims', () => {
    // Supabase and Firebase pages state pricing shape and documented product
    // behaviour, so they must carry primary sources. The no-code page is
    // category-level by design and the traditional-development page compares
    // against a practice rather than a product, so neither has facts to cite —
    // and asserting they do would push someone to invent one.
    expect(COMPARISONS['backenly-vs-supabase'].facts.length).toBeGreaterThanOrEqual(3)
    expect(COMPARISONS['backenly-vs-firebase'].facts.length).toBeGreaterThanOrEqual(2)
    for (const fact of [
      ...COMPARISONS['backenly-vs-supabase'].facts,
      ...COMPARISONS['backenly-vs-firebase'].facts,
    ]) {
      expect(fact.source).toMatch(/^https:\/\/(supabase\.com|firebase\.google\.com|github\.com)\//)
    }
  })

  it('never states a migration service it cannot honour', () => {
    // The specific claim that shipped: "The Backenly team can assist with
    // complex migrations", on a product where Free and Pro both carry
    // supportResponseHours: null. This is narrow and literal on purpose — it
    // guards one retired sentence, not prose style.
    const corpus = JSON.stringify(COMPARISON_LIST).toLowerCase()
    expect(corpus).not.toContain('assist with complex migrations')
    expect(corpus).not.toContain('team helps with complex migrations')

    const migration = COMPARISONS['backenly-vs-supabase'].migration
    expect(migration).toBeDefined()
    // It has to say the work stays with the reader.
    expect(migration!.limits.length).toBeGreaterThanOrEqual(2)
    expect(migration!.limits.join(' ').toLowerCase()).toContain('no migration service')
  })
})

describe('numbers stated in copy are tied to their source', () => {
  // Copy carries exactly three hand-written counts. Each is checked against the
  // authority rather than a second hand-maintained constant, so the failure mode
  // is a red test rather than a page that quietly states last quarter's number.
  //
  // The invariant count is deliberately NOT in the copy — it reads "a set of
  // declared invariants" — because that catalogue moves and a number in prose
  // buys nothing a reader can use.

  it('states the advertised MCP tool count that the catalog actually publishes', () => {
    const { buildCatalog } = require('@/lib/mcp/catalog')
    const advertised = buildCatalog().length

    const WORDS: Record<number, string> = { 19: 'nineteen', 20: 'twenty', 21: 'twenty-one' }
    expect(WORDS[advertised]).toBeDefined()

    const corpus = [
      JSON.stringify(COMPARISON_LIST),
      JSON.stringify(require('@/app/alternatives/data').CRITERIA),
    ]
      .join(' ')
      .toLowerCase()

    // Wherever the surface size is named, it names the real one.
    expect(corpus).toContain(`${WORDS[advertised]} advertised`)
    for (const wrong of Object.values(WORDS).filter((w) => w !== WORDS[advertised])) {
      expect(corpus).not.toContain(`${wrong} advertised`)
    }
  })

  it('states the read-only surface honestly against the derived catalog', () => {
    const { buildCatalog } = require('@/lib/mcp/catalog')
    const readOnly = buildCatalog({ readOnly: true })
    // The claim in copy is that a read-only key withholds every write door,
    // including the natural-language one. That is the load-bearing half.
    expect(readOnly.map((t: { name: string }) => t.name)).not.toContain('backend_chat')
    expect(readOnly.length).toBeGreaterThan(0)
    expect(readOnly.length).toBeLessThan(buildCatalog().length)
  })

  it('states the branch cap the engine enforces', () => {
    // Not exported, so read the authority rather than duplicating the constant.
    const fs = require('fs')
    const path = require('path')
    const engine = fs.readFileSync(
      path.join(process.cwd(), 'lib/branches/engine.ts'),
      'utf8',
    )
    const match = engine.match(/const MAX_ACTIVE_BRANCHES\s*=\s*(\d+)/)
    expect(match).not.toBeNull()

    const WORDS: Record<string, string> = { '3': 'three', '5': 'five', '10': 'ten' }
    const word = WORDS[match![1]]
    expect(word).toBeDefined()
    expect(JSON.stringify(COMPARISON_LIST).toLowerCase()).toContain(`up to ${word} active`)
  })
})

describe('the alternatives page', () => {
  it('carries the sections that make it worth reading', () => {
    expect(CRITERIA.length).toBeGreaterThanOrEqual(4)
    expect(NOT_FOR.length).toBeGreaterThanOrEqual(3)
    expect(DO_NOT_SWITCH.length).toBeGreaterThanOrEqual(3)
    expect(SWITCHING_COSTS.length).toBeGreaterThanOrEqual(3)
    expect(ALT_FAQ.length).toBeGreaterThanOrEqual(3)
  })

  it('is not a second copy of the comparison pages', () => {
    // How the duplication grew last time: someone pasted a comparison paragraph
    // across. Verbatim reuse is checkable; similarity is not, so this checks
    // what it can.
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
    const alt = [
      ...CRITERIA.flatMap((c) => [c.question, c.why, c.backenly]),
      ...NOT_FOR.flatMap((n) => [n.title, n.body]),
      ...DO_NOT_SWITCH.flatMap((d) => [d.title, d.body]),
      ...SWITCHING_COSTS.flatMap((s) => [s.item, s.detail]),
      ...ALT_FAQ.flatMap((f) => [f.q, f.a]),
    ].map(normalize)

    for (const c of COMPARISON_LIST) {
      for (const text of [c.positioning, c.summary, c.intro]) {
        const needle = normalize(text)
        expect(alt.some((a) => a === needle || a.includes(needle))).toBe(false)
      }
    }
  })

  it('holds no per-competitor capability rows of its own', () => {
    // The structural reason the two pages stopped being duplicates: capability
    // comparison lives in one place. If a `table` field ever appears here, the
    // split has quietly been undone.
    const alternativesData = require('@/app/alternatives/data')
    expect(alternativesData.COMPARISON_LIST).toBeUndefined()
    expect(alternativesData.TABLE).toBeUndefined()
    expect(alternativesData.ROWS).toBeUndefined()
  })
})

describe('sitemap parity', () => {
  const urls = sitemap().map((e) => e.url)

  it('lists every comparison route and nothing that does not exist', () => {
    for (const slug of COMPARISON_SLUGS) {
      expect(urls).toContain(`${APP_URL}/comparisons/${slug}`)
    }
    const listed = urls
      .filter((u) => u.startsWith(`${APP_URL}/comparisons/`))
      .map((u) => u.replace(`${APP_URL}/comparisons/`, ''))
    expect(listed.sort()).toEqual([...COMPARISON_SLUGS].sort())
  })

  it('lists both index routes', () => {
    expect(urls).toContain(`${APP_URL}/comparisons`)
    expect(urls).toContain(`${APP_URL}/alternatives`)
  })

  it('has no duplicate URLs', () => {
    expect(new Set(urls).size).toBe(urls.length)
  })
})

describe('route metadata', () => {
  it('sets a self-referencing canonical on every comparison', async () => {
    const { generateMetadata } = require('@/app/comparisons/[slug]/page')
    for (const slug of COMPARISON_SLUGS) {
      const meta = await generateMetadata({ params: Promise.resolve({ slug }) })
      expect(meta.alternates.canonical).toBe(`${APP_URL}/comparisons/${slug}`)
      expect(meta.openGraph.url).toBe(`${APP_URL}/comparisons/${slug}`)
      expect(typeof meta.title).toBe('string')
      expect((meta.description as string).length).toBeGreaterThan(50)
    }
  })

  it('returns Not Found metadata for an unknown slug rather than throwing', async () => {
    const { generateMetadata } = require('@/app/comparisons/[slug]/page')
    const meta = await generateMetadata({ params: Promise.resolve({ slug: 'backenly-vs-nothing' }) })
    expect(meta.title).toBe('Not Found')
    expect(meta.alternates).toBeUndefined()
  })

  it('pre-renders exactly the live slugs', () => {
    const { generateStaticParams } = require('@/app/comparisons/[slug]/page')
    expect(generateStaticParams()).toEqual(COMPARISON_SLUGS.map((slug) => ({ slug })))
  })

  it('carries no stale year keyword on either index', () => {
    // The index shipped 'backend tool comparison 2025' as a keyword. A hardcoded
    // year is the one SEO string that is guaranteed to go wrong on a date.
    const comparisons = require('@/app/comparisons/page').metadata
    const alternatives = require('@/app/alternatives/page').metadata
    for (const meta of [comparisons, alternatives]) {
      expect(JSON.stringify(meta)).not.toMatch(/\b20\d{2}\b/)
    }
    expect(comparisons.alternates.canonical).toBe(`${APP_URL}/comparisons`)
    expect(alternatives.alternates.canonical).toBe(`${APP_URL}/alternatives`)
  })
})

describe('comparison table semantics', () => {
  const rows = COMPARISONS['backenly-vs-supabase'].table
  const html = renderToStaticMarkup(
    createElement(ComparisonTable, {
      caption: 'Backenly compared with Supabase, by capability',
      competitor: 'Supabase',
      rows,
    }),
  )

  it('names the table for assistive technology', () => {
    expect(html).toContain('<caption')
    expect(html).toContain('Backenly compared with Supabase, by capability')
  })

  it('marks column headers with scope', () => {
    const colHeaders = html.match(/<th[^>]*scope="col"/g) ?? []
    expect(colHeaders).toHaveLength(4)
  })

  it('marks the aspect cell of every row as a row header', () => {
    const rowHeaders = html.match(/<th[^>]*scope="row"/g) ?? []
    expect(rowHeaders).toHaveLength(rows.length)
  })

  it('makes the scroll region reachable by keyboard', () => {
    // A bare overflow-x-auto div scrolls only for a pointer. This was a real
    // defect on the previous table, not a hypothetical one.
    expect(html).toMatch(/role="region"[^>]*tabindex="0"|tabindex="0"[^>]*role="region"/i)
    expect(html).toMatch(/aria-label="Backenly compared with Supabase, by capability"/)
  })

  it('renders one accessible copy of each row, not two', () => {
    // Both renderings exist in the DOM; Tailwind's `hidden` is display:none, so
    // exactly one reaches the accessibility tree. If the stacked list ever
    // stopped being hidden at md, every row would be announced twice.
    expect(html).toContain('hidden md:block')
    expect(html).toContain('md:hidden')
  })

  it('gives the mobile rendering the same content as the table', () => {
    // React escapes apostrophes and quotes in text nodes, so the raw copy has to
    // be compared against decoded markup rather than the string as authored.
    const decoded = html
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')

    for (const row of rows) {
      // Once in the table, once in the stacked list.
      expect(decoded.split(row.practical).length - 1).toBe(2)
    }
  })
})

describe('the decision block', () => {
  const c = COMPARISONS['backenly-vs-firebase']
  const html = renderToStaticMarkup(
    createElement(SplitDecision, {
      heading: 'Which one to pick',
      competitor: c.competitor,
      chooseCompetitor: c.chooseCompetitorWhen,
      chooseBackenly: c.chooseBackenlyWhen,
    }),
  )

  it('lives under a real heading', () => {
    // It previously had neither a heading nor an aria-label, which left the most
    // decision-relevant block on the page invisible to landmark navigation.
    expect(html).toMatch(/<h2[^>]*>Which one to pick<\/h2>/)
  })

  it('labels both columns', () => {
    expect(html).toContain('Choose Firebase when')
    expect(html).toContain('Choose Backenly when')
  })

  it('puts the competitor case first in the DOM', () => {
    expect(html.indexOf('Choose Firebase when')).toBeLessThan(html.indexOf('Choose Backenly when'))
  })
})
