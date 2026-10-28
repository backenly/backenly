/**
 * The best-backend guide compares Backenly with five other products, and
 * Backenly wrote it. It is only worth publishing if every row can be checked,
 * so the rules in its content file are held here:
 *
 *   another product's claims   each names an https page on that vendor's own
 *                              site or GitHub organization, and the day it was
 *                              read; silence is "Not documented", never "No"
 *   the comparison             every option answers every criterion
 *   Backenly's claims          each cites a file in this repository, and the
 *                              figures in them match the code: tool counts
 *                              (lib/mcp/catalog.ts), refusal codes
 *                              (lib/mcp/guard.ts, lib/mcp/migration-parser.ts),
 *                              licences, the free plan and restore-point
 *                              retention (app/pricing/page.tsx)
 *
 * This is the guide's counterpart of the "competitor facts sourced" check
 * scripts/verify-content-integrity.ts runs on the comparison pages, except
 * that a claim without a source fails here instead of being reported.
 */

import fs from 'fs'
import path from 'path'
import { buildCatalog } from '@/lib/mcp/catalog'
import { COMPARISON_SLUGS } from '@/app/comparisons/data'
import { FAQ as MCP_FAQ } from '@/app/mcp/data'
import {
  ACCESSED,
  ALTERNATIVES,
  COMPARISON,
  CRITERIA,
  NOTES,
  OPTIONS,
  READ_NEXT,
  SOURCES,
  type Claim,
  type CriterionId,
  type OptionId,
} from '@/app/guides/best-backend-for-claude-code/content'

const root = process.cwd()
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

/** The option whose own site or GitHub organization a URL is on. */
function ownerOf(url: string): OptionId | undefined {
  return OPTIONS.find((o) => o.hosts.some((host) => url === `https://${host}` || url.startsWith(`https://${host}/`)))?.id
}

/** Every claim the page prints: the comparison cells, the notes under them, and "When to pick something else". */
const ALL: Claim[] = [
  ...OPTIONS.flatMap((o) => CRITERIA.flatMap((c) => COMPARISON[o.id][c.id])),
  ...Object.values(NOTES).flatMap((claims) => claims ?? []),
  ...ALTERNATIVES.flatMap((a) => a.claims),
]

const aboutBackenly = ALL.filter((c) => ownerOf(c.source) === 'backenly')
const aboutOthers = ALL.filter((c) => ownerOf(c.source) !== 'backenly')

/** Backenly's cell for one criterion, as the table prints it. */
const backenly = (id: CriterionId) => COMPARISON.backenly[id].map((c) => c.text).join(' ')

describe('every claim about another product is sourced', () => {
  it('names an https page and the day it was read', () => {
    expect(ACCESSED).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(aboutOthers.length).toBeGreaterThan(0)
    for (const claim of aboutOthers) {
      expect(claim.source).toMatch(/^https:\/\/\S+$/)
      expect(claim.accessed).toBe(ACCESSED)
    }
  })

  it('cites only that vendor’s own site or repository', () => {
    for (const claim of aboutOthers) expect([claim.text, ownerOf(claim.source)]).not.toEqual([claim.text, undefined])
    // A cell restates its own product's pages, never another vendor's.
    for (const option of OPTIONS) {
      for (const criterion of CRITERIA) {
        for (const claim of COMPARISON[option.id][criterion.id]) {
          expect([`${option.id}/${criterion.id}`, ownerOf(claim.source)]).toEqual([`${option.id}/${criterion.id}`, option.id])
        }
      }
    }
  })

  it('cites only listed sources, so every link has a name', () => {
    const listed = Object.values(SOURCES).map((s) => s.url)
    for (const claim of ALL) expect(listed).toContain(claim.source)
  })

  it('says “Not documented” where the docs are silent, never a bare “No”', () => {
    for (const claim of aboutOthers) {
      expect(claim.text).not.toMatch(/^(No|None|Not supported|Not available)\b[.,]?\s*$/)
      expect(claim.text).not.toMatch(/^No[.,]/)
    }
  })
})

describe('the comparison is complete', () => {
  it('answers every criterion for every option', () => {
    expect(Object.keys(COMPARISON).sort()).toEqual(OPTIONS.map((o) => o.id).sort())
    for (const option of OPTIONS) {
      for (const criterion of CRITERIA) {
        const cell = COMPARISON[option.id][criterion.id]
        expect([`${option.id}/${criterion.id}`, cell.length > 0]).toEqual([`${option.id}/${criterion.id}`, true])
        for (const claim of cell) expect(claim.text.trim()).not.toBe('')
      }
    }
  })

  it('concedes real cases to the other options', () => {
    // The section that keeps a vendor's guide from being an advertisement.
    expect(ALTERNATIVES.length).toBeGreaterThanOrEqual(3)
    for (const a of ALTERNATIVES) expect(a.claims.some((c) => ownerOf(c.source) !== 'backenly')).toBe(true)
  })
})

describe('Backenly’s claims match this repository', () => {
  it('cite files that exist here', () => {
    for (const claim of aboutBackenly) {
      const local = claim.source.replace(/^https:\/\/github\.com\/backenly\/backenly\/(blob|tree)\/main\//, '')
      expect(fs.existsSync(path.join(root, local)) ? local : `missing: ${local}`).toBe(local)
    }
  })

  it('state the tool counts a read-only and a read-write connection are served', () => {
    const readOnly = buildCatalog({ readOnly: true }).length
    const all = buildCatalog().length
    expect(backenly('readOnly')).toContain(`${readOnly} of the ${all} tools`)
  })

  it('name the refusal codes the server really returns', () => {
    expect(backenly('readOnly')).toContain('READ_ONLY_KEY')
    expect(read('lib/mcp/guard.ts')).toContain("code: 'READ_ONLY_KEY'")
    expect(backenly('destructive')).toContain('DESTRUCTIVE_REFUSED')
    expect(read('lib/mcp/migration-parser.ts')).toContain("'DESTRUCTIVE_REFUSED'")
  })

  it('say the MCP server operates a Backenly project, not any Postgres', () => {
    expect(backenly('connect')).toContain('operates a Backenly project')
    expect(MCP_FAQ.find((f) => /existing PostgreSQL/.test(f.q))!.a).toMatch(/^No\. The server operates a Backenly project/)
  })

  it('say destructive actions wait for a person, and ordinary row writes do not', () => {
    const answer = MCP_FAQ.find((f) => /drop a table/.test(f.q))!.a
    expect(answer).toContain('wait for a person')
    expect(answer).toContain('Ordinary row inserts, updates and deletes run as normal')
    expect(backenly('destructive')).toContain('wait for a person')
    expect(backenly('destructive')).toContain('Row inserts, updates and deletes run as normal')
  })

  it('name the checks protected verification really runs', () => {
    const verify = read('lib/changes/verify.ts')
    for (const label of ['Every step took effect', 'Nothing removed as a side effect', 'Row-level security kept']) {
      expect(verify).toContain(`const label = '${label}'`)
    }
    expect(verify).toContain('A check that could not run leaves the change\n * `unverified`')
    expect(backenly('verify')).toContain('A check that could not run leaves the change marked unverified')
  })

  it('state the licences the repository carries', () => {
    expect(read('LICENSE')).toMatch(/Apache License\s+Version 2\.0/)
    expect(JSON.parse(read('package.json')).license).toBe('Apache-2.0')
    for (const pkg of ['sdk', 'cli', 'mcp-server']) {
      expect([pkg, JSON.parse(read(`packages/${pkg}/package.json`)).license]).toEqual([pkg, 'MIT'])
    }
    expect(backenly('selfHost')).toContain('Apache-2.0')
    expect(backenly('selfHost')).toContain('The SDK, CLI and MCP server are MIT')
  })

  it('state the free plan and restore-point retention the pricing page states', () => {
    // The pricing page keeps a number and its unit together with a no-break space.
    const pricing = read('app/pricing/page.tsx').replace(/\u00a0/g, ' ')
    expect(pricing).toContain("{ text: '1 live project' }")
    expect(pricing).toContain("{ text: '512 MB Postgres database' }")
    expect(pricing).toContain('No credit card.')
    expect(pricing).toContain('open source under Apache-2.0 and free to self-host')
    expect(pricing).toMatch(/label: 'Schema change restore points kept'[^\n]*cells: \['7 days', '30 days', '90 days'\]/)
    expect(pricing).toMatch(/label: 'Daily backups', cells: \['7 days kept'/)
    expect(backenly('free')).toContain('1 live project and a 512 MB Postgres database')
    expect(backenly('restore')).toContain('kept 7 days on Free and 30 on Pro')
    expect(backenly('restore')).toContain('Daily backups are kept 7 days')
  })

  it('describe branches and offline support the way the docs and comparisons do', () => {
    expect(read('app/docs/content.ts')).toContain('Branches are in beta and available on Backenly Cloud.')
    expect(read('app/comparisons/data.ts')).toContain('Backenly has no offline layer')
  })

  it('never claim more than the recovery design does', () => {
    const text = aboutBackenly.map((c) => c.text).join(' ')
    // Not every change can be undone, and not every destructive operation is stopped.
    expect(text).not.toMatch(/every change[^.]*(revers|undo|restor)|always (revers|restor)|can always be (undone|restored)/i)
    expect(text).not.toMatch(/(all|every) destructive (operation|action|call)s? (is|are) (impossible|blocked|refused)/i)
    // Restores are described as they are, never by a list of what they leave out.
    expect(text).not.toMatch(/\b(only|just) (covers? )?(the )?(database|schema)\b|not (in|covered by) (the |a )?(checkpoint|restore point)/i)
  })
})

describe('the guide’s own links resolve', () => {
  it('points “Read next” at live pages', () => {
    for (const { href } of READ_NEXT) {
      const comparison = /^\/comparisons\/(.+)$/.exec(href)
      if (comparison) expect(COMPARISON_SLUGS).toContain(comparison[1])
      else expect(fs.existsSync(path.join(root, 'app', href, 'page.tsx')) ? href : `no page: ${href}`).toBe(href)
    }
  })
})
