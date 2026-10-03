/**
 * Content integrity gate for /resources, /use-cases, /comparisons,
 * /alternatives and /privacy.
 *
 * WHY THIS EXISTS
 * ---------------
 * These two surfaces had no test of any kind. Nothing imported them, nothing
 * rendered them in CI, and the only signal that a guide had rotted was someone
 * reading it. Over time that produced a "60+ governed tools" claim on a surface
 * that advertises 20, a self-healing promise that contradicted the activity
 * gate, and three redirects (/docs, /mcp, /quickstart) pointing at a hub with no
 * connect guide on it.
 *
 * Most of those are judgement calls a script cannot make. These are the ones it
 * can, and they are the ones that rot silently:
 *
 *   1. Cross-references resolve.       A relatedSlug to a deleted guide is a
 *                                      dead "Next" card nobody notices.
 *   2. The sitemap matches reality.    A slug that 404s, or a live page missing
 *                                      from the sitemap, is invisible until a
 *                                      crawler finds it.
 *   3. Redirects do not chain.         Retiring a slug whose old redirect still
 *                                      points at it costs a hop and dilutes the
 *                                      signal. This has already happened once.
 *   4. React keys are unique.          Duplicate section headings collide as
 *                                      anchor ids; duplicate step titles and
 *                                      capability names collide as list keys.
 *   5. Use cases state their limits.   The `limitations` and `responsibility.you`
 *                                      fields are what separate a use case from
 *                                      a brochure, so a thin one fails here.
 *
 * A sixth check lived here and was removed deliberately: a banned-marketing-
 * phrase blocklist. It was measurably brittle. Tested against eight accurate
 * sentences it rejected all eight, because "no.code" matches the ordinary
 * phrase "no code", because it has no notion of negation (a sentence
 * DISCLAIMING "seamless" tripped it), and because it encoded a tool count that
 * can legitimately change. It had already blocked correct copy taken verbatim
 * from a tool description. Failing a production build on prose style is the
 * wrong trade, so the words are a review concern, not a build gate. Everything
 * that remains here is structural and cannot fail on a wording change.
 *
 * WHY /privacy IS IN HERE RATHER THAN IN ITS OWN SCRIPT
 * -----------------------------------------------------
 * Because the machinery it needs already exists here. SURFACE_FILES,
 * staticRouteExists and checkInternalLinks are generic, so listing the privacy
 * page buys link resolution and redirect-source detection for free, and the
 * sitemap helpers already cover an arbitrary route. A second script would also
 * mean a second `verify:*` entry and a second link in the build command, for
 * checks that are the same kind of check over the same kind of data.
 *
 * The same restraint applies as everywhere else in this file: the privacy
 * checks below are STRUCTURAL. None of them can tell whether a legal statement
 * is correct, lawful, or true of production, and a gate that appeared to would
 * be worse than no gate — it would read as validation to the next person.
 * Accuracy against the deployed system stays a human review step.
 *
 * Deliberately DB-free, matching verify-v1-parity.ts and
 * assert-no-apidefinition-writes.ts, so it can run as a build gate.
 *
 * Run: npx tsx scripts/verify-content-integrity.ts   (wired into `npm run build`)
 */

import fs from 'fs'
import path from 'path'
import { ALL_ARTICLES, ARTICLES_BY_SLUG, LANES, READ_MINUTES } from '../app/resources/content'
import { USE_CASE_LIST, USE_CASES } from '../app/use-cases/data'
import { COMPARISON_LIST, COMPARISON_SLUGS } from '../app/comparisons/data'
import {
  CRITERIA,
  DO_NOT_SWITCH,
  FAQ as ALT_FAQ,
  NOT_FOR,
  REASONS_TEAMS_LOOK,
  SWITCHING_COSTS,
} from '../app/alternatives/data'
import {
  EFFECTIVE_DATE,
  PRIVACY_EMAIL,
  PRIVACY_SECTIONS,
  PRIVACY_SUMMARY,
  PROVIDERS,
} from '../app/privacy/data'
import sitemap from '../app/sitemap'

const failures: string[] = []
const fail = (m: string) => failures.push(m)

/**
 * Non-fatal. A competitor fact whose source was last read a long time ago is a
 * review task, not a broken build — failing a deploy because a date rolled past
 * a threshold would train everyone to bump the date rather than re-read the
 * page, which is the opposite of what the field is for.
 */
const warnings: string[] = []
const warn = (m: string) => warnings.push(m)

// ── 1. Guide cross-references, shape, and anchors ────────────────────────────

for (const a of ALL_ARTICLES) {
  for (const s of a.relatedSlugs) {
    if (!ARTICLES_BY_SLUG[s]) fail(`resources/${a.slug}: relatedSlug "${s}" does not exist`)
  }
  if (a.relatedSlugs.includes(a.slug)) fail(`resources/${a.slug}: links to itself`)
  if (!LANES.some((l) => l.id === a.lane)) fail(`resources/${a.slug}: lane "${a.lane}" has no shelf on the index`)
  if (a.sections.length === 0) fail(`resources/${a.slug}: has no sections`)
  if (!a.answers.trim().endsWith('?')) fail(`resources/${a.slug}: "answers" must be the question the page answers`)
  if (new Date(a.dateModified) < new Date(a.datePublished)) fail(`resources/${a.slug}: dateModified precedes datePublished`)
  if (!READ_MINUTES[a.slug] || READ_MINUTES[a.slug] < 1) fail(`resources/${a.slug}: derived read time is not a positive number`)

  const headings = a.sections.map((s) => s.heading)
  if (new Set(headings).size !== headings.length) {
    fail(`resources/${a.slug}: duplicate section headings — the in-page nav anchors will collide`)
  }
}

// ── 2. Use-case shape: the fields that keep a use case honest ────────────────

for (const uc of USE_CASE_LIST) {
  if (uc.workflow.length < 3) fail(`use-cases/${uc.slug}: workflow has only ${uc.workflow.length} steps`)
  if (uc.limitations.length < 3) fail(`use-cases/${uc.slug}: only ${uc.limitations.length} limitations — a use case that cannot say where it stops is a brochure`)
  if (uc.capabilities.length < 3) fail(`use-cases/${uc.slug}: only ${uc.capabilities.length} named capabilities`)
  if (uc.responsibility.you.length < 3) fail(`use-cases/${uc.slug}: "you own" list is too thin to be honest`)
  if (uc.responsibility.platform.length < 3) fail(`use-cases/${uc.slug}: "platform does" list is too thin`)
  if (uc.faq.length < 3) fail(`use-cases/${uc.slug}: only ${uc.faq.length} FAQ entries`)

  const stepTitles = uc.workflow.map((s) => s.title)
  if (new Set(stepTitles).size !== stepTitles.length) fail(`use-cases/${uc.slug}: duplicate workflow step titles (React key collision)`)
  const capNames = uc.capabilities.map((c) => c.name)
  if (new Set(capNames).size !== capNames.length) fail(`use-cases/${uc.slug}: duplicate capability names (React key collision)`)
}

if (Object.keys(USE_CASES).length !== USE_CASE_LIST.length) {
  fail('use-cases: the slug map and the list disagree — a duplicate slug is shadowing an entry')
}

// ── 2b. Comparison shape: the fields that keep a comparison honest ───────────
//
// This section is independent of the Resources / Use Cases checks above and
// shares none of their assumptions. It exists because /comparisons and
// /alternatives had no test of any kind, and the two specific things that rot
// on a comparison page are balance and sourcing.
//
// `competitorStrengths` and `chooseCompetitorWhen` are enforced rather than
// reviewed for one reason: a comparison that cannot say why a reader should
// pick the OTHER product is an advertisement wearing a table, and that is a
// property a script can actually check. It cannot check whether the strengths
// are any good — that stays a review concern — but it can refuse to ship a page
// that does not have any.
//
// There is deliberately no banned-phrase list here, for the reasons recorded in
// the header comment. Everything below is structural and cannot fail on a
// wording change.

const FACT_STALE_DAYS = 180

for (const c of COMPARISON_LIST) {
  const at = (m: string) => fail(`comparisons/${c.slug}: ${m}`)

  if (c.competitorStrengths.length < 2) {
    at(
      `only ${c.competitorStrengths.length} competitor strength(s) — a comparison that cannot say ` +
        `why someone should choose ${c.competitor} is an advertisement`,
    )
  }
  if (c.chooseCompetitorWhen.length < 1) {
    at(`no "choose ${c.competitor} when" entries — the page never concedes a case`)
  }
  if (c.backenlyStrengths.length < 2) at(`only ${c.backenlyStrengths.length} Backenly strength(s)`)
  if (c.table.length < 4) at(`capability table has only ${c.table.length} rows`)
  if (c.architecture.length < 1) at('no architecture section')
  if (c.faq.length < 3) at(`only ${c.faq.length} FAQ entries`)

  // Every row carries all four columns. The fourth is the whole reason these
  // tables are not tick-versus-cross, so an empty one silently reverts the
  // format it was introduced to replace.
  for (const row of c.table) {
    for (const field of ['aspect', 'competitor', 'backenly', 'practical'] as const) {
      if (!row[field] || !row[field].trim()) {
        at(`table row "${row.aspect || '(unnamed)'}" has an empty "${field}" cell`)
      }
    }
  }

  // Duplicate keys collide in React and, for the aspect column, mean the table
  // is silently saying the same thing twice.
  const dupe = (label: string, values: string[]) => {
    if (new Set(values).size !== values.length) at(`duplicate ${label} (React key collision)`)
  }
  dupe('table aspects', c.table.map((r) => r.aspect))
  dupe('architecture headings', c.architecture.map((s) => s.heading))
  dupe('competitor strength titles', c.competitorStrengths.map((s) => s.title))
  dupe('Backenly strength titles', c.backenlyStrengths.map((s) => s.title))
  dupe('FAQ questions', c.faq.map((f) => f.q))

  if (c.migration && c.migration.limits.length < 2) {
    at('migration section names fewer than two things that stay the reader\'s work')
  }

  // Sourcing. A claim about a competitor with no URL and no date is one nobody
  // can ever audit, and competitor pricing and capabilities move.
  for (const fact of c.facts) {
    if (!/^https:\/\//.test(fact.source)) {
      at(`fact source "${fact.source}" is not an https URL`)
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fact.verifiedOn)) {
      at(`fact for ${fact.source} has no ISO verification date`)
      continue
    }
    const ageDays = (Date.now() - new Date(fact.verifiedOn).getTime()) / 86_400_000
    if (ageDays > FACT_STALE_DAYS) {
      warn(
        `comparisons/${c.slug}: ${fact.source} was last read ${Math.round(ageDays)} days ago — ` +
          `re-read it before trusting the claim`,
      )
    }
  }
}

if (new Set(COMPARISON_SLUGS).size !== COMPARISON_SLUGS.length) {
  fail('comparisons: duplicate slug — one entry is shadowing another in the slug map')
}

// ── 2c. Alternatives must not become a second comparisons page ───────────────
//
// It already was one once: the same four competitors, the same capability
// claims, and three of the four entries left on pre-rewrite copy, so the page
// was both the duplicate and the stale half of it. The split is by reader, and
// the way it regrows is someone pasting a comparison paragraph across. Checking
// for verbatim reuse is enough to catch that without pretending to judge prose.

if (CRITERIA.length < 4) fail('alternatives: fewer than four evaluation criteria')
if (NOT_FOR.length < 3) fail('alternatives: fewer than three "not for" entries — the section that earns the page')
if (DO_NOT_SWITCH.length < 3) fail('alternatives: fewer than three "should not switch" entries')
if (SWITCHING_COSTS.length < 3) fail('alternatives: switching-cost list is too thin to be honest')
if (ALT_FAQ.length < 3) fail(`alternatives: only ${ALT_FAQ.length} FAQ entries`)

const altCorpus = [
  ...CRITERIA.flatMap((c) => [c.question, c.why, c.backenly]),
  ...NOT_FOR.flatMap((n) => [n.title, n.body]),
  ...DO_NOT_SWITCH.flatMap((d) => [d.title, d.body]),
  ...REASONS_TEAMS_LOOK.flatMap((r) => [r.title, r.body]),
  ...SWITCHING_COSTS.flatMap((s) => [s.item, s.detail]),
  ...ALT_FAQ.flatMap((f) => [f.q, f.a]),
]

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
const altNormalized = altCorpus.map(normalize)

for (const c of COMPARISON_LIST) {
  for (const [label, text] of [
    ['positioning', c.positioning],
    ['summary', c.summary],
    ['intro', c.intro],
  ] as const) {
    const needle = normalize(text)
    if (altNormalized.some((a) => a === needle || a.includes(needle))) {
      fail(
        `alternatives duplicates the ${label} of comparisons/${c.slug} verbatim — ` +
          `the two pages are for different readers, link instead of restating`,
      )
    }
  }
}

// ── 2d. Privacy policy: structure, anchors, and provider-table completeness ──
//
// STRUCTURAL ONLY. Nothing below can judge whether a legal statement is
// correct — see the note at the top of this file. What these catch is the way
// a legal page actually rots: a section quietly dropped, an anchor collision
// that silently breaks every deep link into the policy, a stale effective
// date, a contact address that drifts from the one the site uses, and a
// provider added to the table with half its row filled in.
//
// That last one is the reason this section exists at all. The policy this
// replaced named three third parties when ten could receive data, because
// there was nothing anywhere that could notice an omission.

/**
 * Sections the policy must always contain.
 *
 * Not "sections it happens to have today". Each of these answers a question a
 * reader arrives with, and a rewrite that drops one has removed an answer
 * rather than tightened the prose. Reordering and retitling stay free; the
 * anchors are slugs precisely so that reordering costs nothing.
 */
const REQUIRED_PRIVACY_SECTIONS = [
  'who-we-are',
  'information-we-collect',
  'how-we-use-it',
  'providers',
  'international',
  'retention',
  'deletion',
  'security',
  'your-rights',
  'changes',
]

const privacyIds = PRIVACY_SECTIONS.map((s) => s.id)

for (const required of REQUIRED_PRIVACY_SECTIONS) {
  if (!privacyIds.includes(required)) {
    fail(`privacy: required section "${required}" is missing — a reader's question lost its answer`)
  }
}

if (new Set(privacyIds).size !== privacyIds.length) {
  fail('privacy: duplicate section id — the anchors collide and one section becomes unreachable')
}

for (const section of PRIVACY_SECTIONS) {
  // Slug-shaped, and never ordinal. Two separate checks, because a shape test
  // alone passes `section-2` — it is a perfectly well-formed slug and also
  // exactly the pattern being retired. `#section-3` derives from array
  // position, so reordering silently repoints every external link into the
  // policy, which is what these anchors were before this rewrite.
  if (!/^[a-z][a-z0-9-]*$/.test(section.id)) {
    fail(`privacy/${section.id}: section id must be a lowercase slug, not free text`)
  }
  if (/^(section-?)?\d+$/.test(section.id)) {
    fail(
      `privacy/${section.id}: section id is positional — renumbering would break every ` +
        `external link into the policy. Name the section, do not number it.`,
    )
  }
  if (!section.title.trim()) fail(`privacy/${section.id}: has no title`)
  if (!section.content.trim()) fail(`privacy/${section.id}: has no body text`)

  for (const sub of section.subsections ?? []) {
    if (sub.items.length === 0) fail(`privacy/${section.id}: subsection "${sub.label}" is empty`)
    if (new Set(sub.items).size !== sub.items.length) {
      fail(`privacy/${section.id}: duplicate items in "${sub.label}" (React key collision)`)
    }
  }
  if (section.list && new Set(section.list).size !== section.list.length) {
    fail(`privacy/${section.id}: duplicate list items (React key collision)`)
  }
}

// Exactly one section renders the provider table. Two would duplicate it; none
// would drop the disclosure while leaving the data in the file, which is the
// failure that looks most like success.
const providerSections = PRIVACY_SECTIONS.filter((s) => s.providers)
if (providerSections.length !== 1) {
  fail(
    `privacy: expected exactly one section to render the provider table, found ${providerSections.length}`,
  )
}

if (PROVIDERS.length === 0) fail('privacy: the provider table is empty')

const providerNames = PROVIDERS.map((p) => p.name)
if (new Set(providerNames).size !== providerNames.length) {
  fail('privacy: duplicate provider name — one row is shadowing another')
}

for (const provider of PROVIDERS) {
  const at = (m: string) => fail(`privacy/providers/${provider.name}: ${m}`)
  if (!provider.name.trim()) at('has no name')
  if (!provider.purpose.trim()) at('has no purpose — a provider nobody can explain should not be listed')
  if (!provider.data.trim()) at('does not say what information it can receive')
  if (!/^https:\/\//.test(provider.href)) at('must link to the provider’s own privacy documentation over https')
}

// Effective date must be real and parseable. A legal page whose date has gone
// to "TBD" or drifted into a placeholder is worse than one with an old date.
if (Number.isNaN(new Date(EFFECTIVE_DATE).getTime())) {
  fail(`privacy: effective date "${EFFECTIVE_DATE}" does not parse as a date`)
}

if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(PRIVACY_EMAIL)) {
  fail(`privacy: contact address "${PRIVACY_EMAIL}" is not a valid email address`)
}

// The policy's contact address and the site's must not drift apart. Read as
// text rather than imported: SiteShell is a client component that pulls in
// React, framer-motion and iconify, none of which belong in a build gate.
{
  const shellPath = path.join(process.cwd(), 'components/site/SiteShell.tsx')
  if (!fs.existsSync(shellPath)) {
    fail('privacy: components/site/SiteShell.tsx is missing, cannot verify the contact address')
  } else if (!fs.readFileSync(shellPath, 'utf8').includes(PRIVACY_EMAIL)) {
    fail(
      `privacy: contact address ${PRIVACY_EMAIL} does not appear in SiteShell's ROUTES — ` +
        `the policy and the site footer are pointing at different addresses`,
    )
  }
}

if (PRIVACY_SUMMARY.length === 0) fail('privacy: the summary has no entries')
if (new Set(PRIVACY_SUMMARY).size !== PRIVACY_SUMMARY.length) {
  fail('privacy: duplicate summary line (React key collision)')
}

// ── 3. Sitemap drift ─────────────────────────────────────────────────────────

const urls = sitemap().map((e) => e.url.replace('https://backenly.com', '') || '/')
if (new Set(urls).size !== urls.length) fail('sitemap: contains duplicate URLs')

const listed = (prefix: string) => urls.filter((u) => u.startsWith(prefix)).map((u) => u.replace(prefix, ''))
const compare = (label: string, prefix: string, real: string[]) => {
  const inSitemap = listed(prefix)
  for (const s of inSitemap) if (!real.includes(s)) fail(`sitemap lists ${prefix}${s}, which does not exist`)
  for (const s of real) if (!inSitemap.includes(s)) fail(`${prefix}${s} exists but is missing from the sitemap`)
  return `${inSitemap.length} ${label}`
}

const resourceCount = compare('resource', '/resources/', ALL_ARTICLES.map((a) => a.slug))
const useCaseCount = compare('use-case', '/use-cases/', USE_CASE_LIST.map((u) => u.slug))
const comparisonCount = compare('comparison', '/comparisons/', [...COMPARISON_SLUGS])

// The two index routes are hand-listed in the sitemap rather than derived, so
// they are the ones that can silently go missing.
for (const index of ['/comparisons', '/alternatives', '/privacy']) {
  if (!urls.includes(index)) fail(`${index} exists but is missing from the sitemap`)
}

// /privacy must stay crawlable. It is linked from the signup consent line and
// from every auth screen, so a stray disallow makes the policy a user is being
// asked to agree to unreachable to anything but a logged-in browser.
{
  const robotsSrc = fs.readFileSync(path.join(process.cwd(), 'app/robots.ts'), 'utf8')
  const disallow = robotsSrc.slice(robotsSrc.indexOf('disallow'))
  if (/['"]\/privacy\/?['"]/.test(disallow)) {
    fail('robots.ts disallows /privacy, which is linked from signup as the policy users must accept')
  }
}

// ── 4. Redirect hygiene ──────────────────────────────────────────────────────

async function checkRedirects(): Promise<void> {
  // Required at call time: next.config.js is CommonJS and reads env.
  const config = require('../next.config.js')
  if (typeof config.redirects !== 'function') return
  const rules: { source: string; destination: string; has?: unknown }[] = await config.redirects()

  // Only unconditional rules define a source that always redirects.
  const sources = new Set(rules.filter((r) => !r.has).map((r) => r.source))
  for (const r of rules) {
    if (sources.has(r.destination)) {
      fail(`redirect chain: ${r.source} → ${r.destination}, which itself redirects. Point it at the final destination.`)
    }
  }

  // A retired slug must not still be served: if a page exists at the source, the
  // redirect never fires and the rule is a lie.
  const liveResources = new Set(ALL_ARTICLES.map((a) => `/resources/${a.slug}`))
  const liveUseCases = new Set(USE_CASE_LIST.map((u) => `/use-cases/${u.slug}`))
  for (const r of rules) {
    if (liveResources.has(r.source) || liveUseCases.has(r.source)) {
      fail(`redirect ${r.source} → ${r.destination} is dead: a page still exists at that slug`)
    }
  }

  // Every internal redirect destination must resolve to something real.
  for (const r of rules) {
    if (r.destination.startsWith('/resources/') && !liveResources.has(r.destination)) {
      fail(`redirect ${r.source} points at ${r.destination}, which does not exist`)
    }
    if (r.destination.startsWith('/use-cases/') && !liveUseCases.has(r.destination)) {
      fail(`redirect ${r.source} points at ${r.destination}, which does not exist`)
    }
  }
}

// ── 5. Internal links on the comparison and alternatives surfaces ────────────
//
// The defect this exists for: /alternatives linked to /use-cases/startup-mvps
// with the label "Startup MVPs", long after that slug was retired and pointed
// at the /use-cases index by a permanent redirect. Nothing 404'd, so nothing
// noticed — the reader just landed somewhere other than the page they were
// promised, one hop later.
//
// A filesystem check alone would not have caught it, because
// app/use-cases/[slug]/page.tsx exists and matches any slug. So a link into one
// of the three dynamic families is validated against that family's actual data,
// and every link is checked against the redirect table. Static routes fall
// through to the router's own resolution rules.

const SURFACE_FILES = [
  'app/comparisons/page.tsx',
  'app/comparisons/[slug]/page.tsx',
  'app/comparisons/data.ts',
  'app/alternatives/page.tsx',
  'app/alternatives/data.ts',
  // The legal pages cross-link to each other. A retired or renamed legal route
  // leaves a dead link in a document people are asked to accept at signup.
  'app/privacy/page.tsx',
  'app/privacy/data.ts',
]

/** Resolve a static pathname against the App Router directory layout. */
function staticRouteExists(pathname: string): boolean {
  const segments = pathname.split('/').filter(Boolean)
  let dir = path.join(process.cwd(), 'app')
  for (const segment of segments) {
    const literal = path.join(dir, segment)
    if (fs.existsSync(literal) && fs.statSync(literal).isDirectory()) {
      dir = literal
      continue
    }
    const dynamic = fs
      .readdirSync(dir, { withFileTypes: true })
      .find((e) => e.isDirectory() && /^\[.+\]$/.test(e.name))
    if (!dynamic) return false
    dir = path.join(dir, dynamic.name)
  }
  return ['page.tsx', 'page.ts', 'page.jsx', 'page.js'].some((f) =>
    fs.existsSync(path.join(dir, f)),
  )
}

async function checkInternalLinks(): Promise<void> {
  const config = require('../next.config.js')
  const rules: { source: string; destination: string; has?: unknown }[] =
    typeof config.redirects === 'function' ? await config.redirects() : []
  const redirectSources = new Set(rules.filter((r) => !r.has).map((r) => r.source))

  const dynamicFamilies: Record<string, Set<string>> = {
    '/comparisons/': new Set(COMPARISON_SLUGS),
    '/use-cases/': new Set(USE_CASE_LIST.map((u) => u.slug)),
    '/resources/': new Set(ALL_ARTICLES.map((a) => a.slug)),
  }

  for (const file of SURFACE_FILES) {
    const full = path.join(process.cwd(), file)
    if (!fs.existsSync(full)) {
      fail(`content integrity: ${file} is listed as a comparison surface but does not exist`)
      continue
    }
    const source = fs.readFileSync(full, 'utf8')

    // href="/x", href: '/x', href={`/x`} — string literals only. A computed
    // href cannot be resolved here and is covered by the family checks above.
    const hrefs = new Set<string>()
    for (const m of source.matchAll(/href(?:=|:\s*)["'`](\/[^"'`${}\s]*)["'`]/g)) {
      hrefs.add(m[1])
    }

    for (const href of hrefs) {
      const pathname = href.split(/[?#]/)[0].replace(/\/$/, '') || '/'

      if (redirectSources.has(pathname)) {
        fail(
          `${file}: links to ${pathname}, which is a redirect source — link to the final ` +
            `destination, or remove the link if the page it promised is gone`,
        )
        continue
      }

      const family = Object.keys(dynamicFamilies).find((p) => pathname.startsWith(p))
      if (family) {
        const slug = pathname.slice(family.length)
        if (slug && !dynamicFamilies[family].has(slug)) {
          fail(`${file}: links to ${pathname}, which is not a live ${family.slice(1, -1)} slug`)
        }
        continue
      }

      if (!staticRouteExists(pathname)) {
        fail(`${file}: links to ${pathname}, which does not resolve to a page`)
      }
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

checkRedirects()
  .then(checkInternalLinks)
  .catch((e) => fail(`redirect check could not run: ${e?.message ?? e}`))
  .then(() => {
    if (warnings.length > 0) {
      console.warn(`\n! Content integrity: ${warnings.length} warning(s)\n`)
      for (const w of warnings) console.warn(`  • ${w}`)
      console.warn('')
    }
    if (failures.length > 0) {
      console.error(`\n✗ Content integrity: ${failures.length} problem(s)\n`)
      for (const f of failures) console.error(`  • ${f}`)
      console.error('')
      process.exit(1)
    }
    console.log(
      `✓ Content integrity: ${ALL_ARTICLES.length} guides + ${USE_CASE_LIST.length} use cases + ` +
        `${COMPARISON_LIST.length} comparisons · ${resourceCount} + ${useCaseCount} + ` +
        `${comparisonCount} sitemap URLs match · redirects unchained · internal links resolve · ` +
        `every comparison concedes a case · competitor facts sourced · keys unique · ` +
        `privacy: ${PRIVACY_SECTIONS.length} sections, ${PROVIDERS.length} providers disclosed, ` +
        `anchors unique, effective ${EFFECTIVE_DATE}`,
    )
  })
