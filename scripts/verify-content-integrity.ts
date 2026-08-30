/**
 * Content integrity gate for /resources and /use-cases.
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
 * Deliberately DB-free, matching verify-v1-parity.ts and
 * assert-no-apidefinition-writes.ts, so it can run as a build gate.
 *
 * Run: npx tsx scripts/verify-content-integrity.ts   (wired into `npm run build`)
 */

import { ALL_ARTICLES, ARTICLES_BY_SLUG, LANES, READ_MINUTES } from '../app/resources/content'
import { USE_CASE_LIST, USE_CASES } from '../app/use-cases/data'
import sitemap from '../app/sitemap'

const failures: string[] = []
const fail = (m: string) => failures.push(m)

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

// ── Report ───────────────────────────────────────────────────────────────────

checkRedirects()
  .catch((e) => fail(`redirect check could not run: ${e?.message ?? e}`))
  .then(() => {
    if (failures.length > 0) {
      console.error(`\n✗ Content integrity: ${failures.length} problem(s)\n`)
      for (const f of failures) console.error(`  • ${f}`)
      console.error('')
      process.exit(1)
    }
    console.log(
      `✓ Content integrity: ${ALL_ARTICLES.length} guides + ${USE_CASE_LIST.length} use cases · ` +
        `${resourceCount} + ${useCaseCount} sitemap URLs match · redirects unchained · keys unique`,
    )
  })
