/**
 * Article content model for /resources.
 *
 * One file per article in this directory, aggregated by ./index.ts. Adding a
 * weekly article = one new file + one index entry + one sitemap line. Keep
 * every claim in an article true of the live product — these pages are read
 * by people deciding whether to trust us with their backend.
 */

export type ArticleBlock =
  | { kind: 'p'; text: string }
  | { kind: 'code'; language: string; label?: string; code: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'note'; text: string }

export type ArticleSection = {
  heading: string
  blocks: ArticleBlock[]
}

export type ArticleData = {
  slug: string
  title: string
  metaDescription: string
  category: string
  readTime: string
  /** ISO dates — must reflect when the content actually shipped / changed. */
  datePublished: string
  dateModified: string
  dateDisplay: string
  intro: string
  sections: ArticleSection[]
  conclusion: string
  relatedSlugs: string[]
}

export const ARTICLE_AUTHOR = {
  name: 'Adarsh Chiriyamkandath Jose',
  role: 'Founder, Backenly',
  url: 'https://www.linkedin.com/company/117034579',
} as const
