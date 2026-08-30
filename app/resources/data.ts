import { ALL_ARTICLES, READ_MINUTES } from './content'

/**
 * Lightweight index derived from the full content in ./content — the card data
 * can never drift from the guides themselves, and `readMinutes` is computed
 * from each guide's own text rather than typed by hand.
 */
export const articles = ALL_ARTICLES.map((a) => ({
  slug: a.slug,
  title: a.title,
  description: a.metaDescription,
  answers: a.answers,
  category: a.category,
  lane: a.lane,
  readMinutes: READ_MINUTES[a.slug],
  date: a.dateModified,
}))

export type ArticleCard = (typeof articles)[number]
