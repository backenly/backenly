import type { ArticleData, ArticleLane } from './types'
import { estimateReadMinutes } from './types'
import { article as connectYourCodingAgent } from './connect-your-coding-agent'
import { article as yourFirstBackend } from './your-first-backend'
import { article as theDataApi } from './the-data-api'
import { article as howBackenlyWorks } from './how-backenly-works'
import { article as accessControlAndRls } from './access-control-and-rls'
import { article as afterYouLaunch } from './after-you-launch'
import { article as selfHosting } from './self-hosting'

export type { ArticleData, ArticleSection, ArticleBlock, ArticleLane } from './types'
export { ARTICLE_AUTHOR, estimateReadMinutes } from './types'

/**
 * Ordered as a reading path, not by date. Someone landing on /resources for the
 * first time should be able to read top to bottom and end up with a working
 * backend they understand.
 */
export const ALL_ARTICLES: ArticleData[] = [
  connectYourCodingAgent,
  yourFirstBackend,
  theDataApi,
  howBackenlyWorks,
  accessControlAndRls,
  afterYouLaunch,
  selfHosting,
]

export const ARTICLES_BY_SLUG: Record<string, ArticleData> = Object.fromEntries(
  ALL_ARTICLES.map((a) => [a.slug, a]),
)

export const LANES: { id: ArticleLane; title: string; body: string }[] = [
  {
    id: 'start',
    title: 'Get running',
    body: 'Connect an agent, build the first backend, and wire a frontend to it.',
  },
  {
    id: 'mechanism',
    title: 'How it works',
    body: 'The architecture, the authorization model, what happens after launch, and how to run the whole thing yourself.',
  },
]

/** Guides on one shelf, in reading order. */
export function articlesInLane(lane: ArticleLane): ArticleData[] {
  return ALL_ARTICLES.filter((a) => a.lane === lane)
}

/**
 * Reading time, derived from each guide's own text so an edit can never leave a
 * stale number on the index card.
 */
export const READ_MINUTES: Record<string, number> = Object.fromEntries(
  ALL_ARTICLES.map((a) => [a.slug, estimateReadMinutes(a)]),
)
