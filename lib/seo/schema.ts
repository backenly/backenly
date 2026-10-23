import { SITE_NAME, SITE_URL } from './metadata'

/**
 * Structured data shared across the marketing site.
 *
 * The organization and the site are declared once, in the root layout, under
 * stable `@id`s. Page-level nodes (a docs article, the product on the home
 * page) point at them by `@id` instead of restating them, so search engines
 * read one connected graph rather than a fresh "Backenly" on every block.
 */

export const ORGANIZATION_ID = `${SITE_URL}/#organization`
export const WEBSITE_ID = `${SITE_URL}/#website`
export const SOFTWARE_ID = `${SITE_URL}/#software`

/** A raster logo: Google requires one it can show in results, at least 112px square. */
export const LOGO_URL = `${SITE_URL}/logo-512.png`

export const organizationNode = {
  '@type': 'Organization',
  '@id': ORGANIZATION_ID,
  name: SITE_NAME,
  url: SITE_URL,
  logo: { '@type': 'ImageObject', url: LOGO_URL, width: 512, height: 512 },
  description:
    'Backenly is the autonomous backend for AI coding agents. Agents build and change production backends over MCP; Backenly checkpoints and verifies each schema change, holds destructive operations for a person\'s approval, and fixes a short list of safe problems on its own. Self-host it under Apache-2.0 or use Backenly Cloud.',
  foundingDate: '2024',
  email: 'support@backenly.com',
  // Profiles that are Backenly's own, so a search engine can tie them to this
  // site. Directory listings and the Discord invite are not identities.
  sameAs: [
    'https://github.com/backenly',
    'https://x.com/Backenly',
    'https://www.linkedin.com/company/117034579',
  ],
}

export const websiteNode = {
  '@type': 'WebSite',
  '@id': WEBSITE_ID,
  name: SITE_NAME,
  url: SITE_URL,
  inLanguage: 'en',
  description: 'The autonomous backend platform. Your coding agent builds it; Backenly keeps it running.',
  publisher: { '@id': ORGANIZATION_ID },
}

/** The product. Rendered on the home page, which is the page about it. */
export const softwareNode = {
  '@type': 'SoftwareApplication',
  '@id': SOFTWARE_ID,
  name: SITE_NAME,
  url: SITE_URL,
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Web',
  description:
    'The autonomous backend for AI coding agents. Agents build PostgreSQL schemas, REST APIs, auth, storage, realtime and functions over MCP. Each schema change is checkpointed and verified against the live database, and destructive operations wait for a person\'s approval. An autonomy loop checks running projects every minute and applies on its own only fixes it can verify and undo. Self-host under Apache-2.0 or use Backenly Cloud.',
  license: 'https://www.apache.org/licenses/LICENSE-2.0',
  isAccessibleForFree: true,
  publisher: { '@id': ORGANIZATION_ID },
  // Free and Pro are self-serve with published prices; Enterprise is quoted,
  // so it is not an Offer with a price.
  offers: [
    { '@type': 'Offer', name: 'Free', price: '0', priceCurrency: 'USD', url: `${SITE_URL}/pricing` },
    {
      '@type': 'Offer',
      name: 'Pro',
      price: '25',
      priceCurrency: 'USD',
      url: `${SITE_URL}/pricing`,
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: '25',
        priceCurrency: 'USD',
        unitCode: 'MON',
        referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitCode: 'MON' },
      },
    },
  ],
  featureList: [
    'MCP server, CLI, and agent skill for coding agents',
    'REST APIs on PostgREST with OpenAPI and typed clients',
    'An isolated PostgreSQL schema per project, with pgvector',
    'Built-in authentication: email, OAuth, magic links',
    'File storage',
    'Realtime subscriptions over Server-Sent Events',
    'Event triggers, cron schedules, and webhooks',
    'Row-level security and permissions',
    'Governed schema changes: checkpoint, verification against the live database, approval for destructive operations',
    'Monitoring every minute, with automatic fixes limited to ones it can verify and undo',
    'Database branches, teams, and organizations',
    'Direct Postgres connection strings and pg_dump export',
    'Open source under Apache-2.0 with free self-hosting (MIT SDK, CLI, and MCP server)',
  ],
}

/** One `<script type="application/ld+json">` body for several nodes. */
export function graph(...nodes: object[]) {
  return { '@context': 'https://schema.org', '@graph': nodes }
}
