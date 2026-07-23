import { MetadataRoute } from 'next'

const APP_URL = 'https://backenly.com'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: [
          '/',
          '/features',
          '/features/',
          '/pricing',
          '/resources',
          '/resources/',
          '/use-cases',
          '/use-cases/',
          '/contact',
          '/alternatives',
          '/terms',
          '/privacy',
          '/refund-policy',
        ],
        disallow: [
          '/app/',
          '/api/',
          '/admin/',
          '/test/',
          '/seed-db/',
          '/auth/',
          '/connect/',
          '/new/',
          '/p/',
          '/_next/',
        ],
      },
    ],
    sitemap: `${APP_URL}/sitemap.xml`,
    host: APP_URL,
  }
}
