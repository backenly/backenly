import { ALL_ARTICLES } from './content'

/**
 * Lightweight article index derived from the full content in ./content — the
 * index card data can never drift from the articles themselves.
 */
export const articles = ALL_ARTICLES.map((a) => ({
  slug: a.slug,
  title: a.title,
  description: a.metaDescription,
  category: a.category,
  readTime: a.readTime,
  date: a.dateModified,
}))
