import type { ArticleData } from './types'
import { article as whatIsAiBackendGeneration } from './what-is-ai-backend-generation'
import { article as howToBuildABackendWithoutCoding } from './how-to-build-a-backend-without-coding'
import { article as bestBackendToolsForNonTechnicalFounders } from './best-backend-tools-for-non-technical-founders'
import { article as fullStackDevelopmentWithAiCodingAgents } from './full-stack-development-with-ai-coding-agents'
import { article as backendDevelopmentForAiAppBuilders } from './backend-development-for-ai-app-builders'

export type { ArticleData, ArticleSection, ArticleBlock } from './types'
export { ARTICLE_AUTHOR } from './types'

/** Ordered newest-first for the /resources index page. */
export const ALL_ARTICLES: ArticleData[] = [
  whatIsAiBackendGeneration,
  howToBuildABackendWithoutCoding,
  bestBackendToolsForNonTechnicalFounders,
  fullStackDevelopmentWithAiCodingAgents,
  backendDevelopmentForAiAppBuilders,
]

export const ARTICLES_BY_SLUG: Record<string, ArticleData> = Object.fromEntries(
  ALL_ARTICLES.map((a) => [a.slug, a]),
)
