/**
 * Content model for /resources.
 *
 * /resources is the DOCUMENTATION surface, not a blog. `/docs`, `/mcp` and
 * `/quickstart` all redirect here (next.config.js) and the site footer links to
 * it as "Documentation", so a page here has to answer a question someone is
 * holding, not rank for one.
 *
 * One file per guide in this directory, aggregated by ./index.ts. Adding a guide
 * = one new file + one index entry + one sitemap line.
 *
 * Every claim in a guide must be true of the live product. These pages are read
 * by people deciding whether to trust us with their backend, and by agents that
 * fetch them at run time. When a capability is plan-gated, partial, or reached
 * through `backend_chat` rather than an advertised tool, say so in the guide
 * rather than letting the reader discover it.
 */

export type ArticleBlock =
  | { kind: 'p'; text: string }
  | { kind: 'code'; language: string; label?: string; code: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'note'; text: string }
  /**
   * An ordered mechanism: what goes in, what the platform does, what comes out.
   * Use this instead of three paragraphs whenever the point is a sequence — it
   * is the shape the reader is actually trying to extract from the prose.
   */
  | { kind: 'steps'; steps: { label: string; title: string; body: string }[] }
  /** A comparison the reader would otherwise have to build themselves. */
  | { kind: 'table'; columns: string[]; rows: string[][]; caption?: string }
  /**
   * The division of labour. Every guide on this site is answering some version
   * of "what do I still own?", so it gets one component rather than nine
   * different prose renderings.
   */
  | { kind: 'responsibility'; platform: string[]; you: string[] }

export type ArticleSection = {
  heading: string
  blocks: ArticleBlock[]
}

/**
 * Which shelf a guide sits on.
 *
 *   'start'     — you have not connected anything yet.
 *   'mechanism' — you are connected and want to know what actually happens.
 */
export type ArticleLane = 'start' | 'mechanism'

export type ArticleData = {
  slug: string
  title: string
  metaDescription: string
  lane: ArticleLane
  /** Short shelf label rendered as the card tag, e.g. "Setup", "Architecture". */
  category: string
  /** One line: the question this page answers. Rendered on the index card. */
  answers: string
  /** ISO dates — must reflect when the content actually shipped / changed. */
  datePublished: string
  dateModified: string
  dateDisplay: string
  intro: string
  sections: ArticleSection[]
  conclusion: string
  relatedSlugs: string[]
}

/**
 * Reading time is DERIVED from the guide's own text (see ./index.ts), never
 * hand-written. A hand-typed "9 min read" is an unverifiable number on a site
 * whose whole argument is that its numbers are checkable, and it drifts the
 * moment anyone edits a section.
 */
export function estimateReadMinutes(a: ArticleData): number {
  const parts: string[] = [a.intro, a.conclusion]

  for (const section of a.sections) {
    parts.push(section.heading)
    for (const block of section.blocks) {
      switch (block.kind) {
        case 'p':
        case 'note':
          parts.push(block.text)
          break
        case 'list':
          parts.push(...block.items)
          break
        case 'code':
          // Code is scanned, not read. Count it at a flat, lower weight rather
          // than at prose speed, which would triple the estimate on the
          // snippet-heavy pages.
          parts.push(...block.code.split('\n').slice(0, 12))
          break
        case 'steps':
          for (const s of block.steps) parts.push(s.title, s.body)
          break
        case 'table':
          parts.push(...block.columns, ...block.rows.flat())
          break
        case 'responsibility':
          parts.push(...block.platform, ...block.you)
          break
      }
    }
  }

  const words = parts.join(' ').trim().split(/\s+/).filter(Boolean).length
  return Math.max(1, Math.round(words / 220))
}

export const ARTICLE_AUTHOR = {
  name: 'Adarsh Chiriyamkandath Jose',
  role: 'Founder, Backenly',
  url: 'https://www.linkedin.com/company/117034579',
} as const
