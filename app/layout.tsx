import type { Metadata, Viewport } from 'next'
import './globals.css'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import { CommandPalette } from '@/components/app/CommandPalette'
import { AmplitudeAnalytics } from '@/components/app/AmplitudeAnalytics'
import { ErrorBoundaryWrapper } from './error-boundary-wrapper'
import { safeJsonLd } from '@/lib/security/safe-jsonld'

const APP_URL = 'https://backenly.com'

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#000000',
  colorScheme: 'dark',
}

export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: {
    default: 'Backenly | The Autonomous Backend Platform',
    template: '%s | Backenly',
  },
  description:
    'Your coding agent builds it; Backenly keeps it running: real Postgres, APIs, auth, storage, and realtime over MCP, with every change governed, verified, and reversible. Open source under Apache-2.0: self-host it, or run on Backenly Cloud.',
  authors: [{ name: 'Backenly', url: APP_URL }],
  creator: 'Backenly',
  publisher: 'Backenly',
  category: 'technology',
  verification: {
    google: '9YmRJ6jU7I_1bQ_fqYJbcJ7lqzqXQhXO6YL4eJhstLs',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: APP_URL,
    siteName: 'Backenly',
    title: 'Backenly | The Autonomous Backend Platform',
    description:
      'Your coding agent builds it. Backenly keeps it running. Real Postgres, REST APIs, auth, storage, and realtime over MCP. Every change planned, applied, verified, and reversible, with autonomous repair on every plan. Open source: self-host or cloud.',
    images: [
      {
        url: '/og.png?v=agent-era',
        width: 1200,
        height: 630,
        alt: 'Backenly: your coding agent builds it; Backenly keeps it running.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Backenly | The Autonomous Backend Platform',
    description:
      'Your coding agent builds it. Backenly keeps it running. An open-source, governed backend for Claude Code, Cursor, and any MCP agent, with autonomous monitoring and repair on every plan. Self-host or cloud.',
    images: ['/og.png?v=agent-era'],
    creator: '@Backenly',
    site: '@Backenly',
  },
  alternates: {
    canonical: APP_URL,
  },
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon.png', type: 'image/png', sizes: '32x32' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
    ],
    shortcut: '/favicon.ico',
    apple: '/apple-touch-icon.png',
  },
}

const organizationSchema = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Backenly',
  url: APP_URL,
  logo: `${APP_URL}/backenly-icon-hd.svg`,
  description:
    'Backenly is the open-source autonomous backend platform: infrastructure that plans, builds, runs, and keeps itself healthy. Coding agents drive it over MCP through governed, reversible changes. Self-host under Apache-2.0 or run on Backenly Cloud.',
  foundingDate: '2024',
  sameAs: [
    'https://github.com/backenly/backenly-js',
    'https://x.com/Backenly',
    'https://www.linkedin.com/company/117034579',
  ],
}

const softwareSchema = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Backenly',
  url: APP_URL,
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Web',
  description:
    'Open-source autonomous backend platform. Coding agents build on it over MCP (PostgreSQL, REST APIs, auth, storage, realtime, and functions) with governed changes, verification, approvals, and rollback. A resident autonomy loop monitors and repairs the running backend on every plan. Self-host under Apache-2.0 or use Backenly Cloud.',
  offers: {
    '@type': 'AggregateOffer',
    priceCurrency: 'USD',
    lowPrice: '0',
    highPrice: '25',
    offerCount: '3',
  },
  featureList: [
    'MCP server, CLI, and agent skill for coding agents',
    'AI-generated REST APIs with OpenAPI and typed clients',
    'PostgreSQL database with instant schema generation and pgvector',
    'Built-in authentication: email, OAuth, magic links',
    'File storage',
    'Realtime subscriptions via SSE',
    'Event triggers, cron schedules, and webhooks',
    'Row-level security and permissions',
    'Governed changes with approvals, verification, and rollback',
    'Autonomous monitoring and self-repair',
    'Database branches, teams, and organizations',
    'Direct Postgres connection strings and pg_dump export',
    'Open source under Apache-2.0 with free self-hosting (MIT SDK, CLI, and MCP server)',
  ],
}

const websiteSchema = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'Backenly',
  url: APP_URL,
  description: 'The autonomous backend platform. Your coding agent builds it; Backenly keeps it running.',
  potentialAction: {
    '@type': 'SearchAction',
    target: {
      '@type': 'EntryPoint',
      urlTemplate: `${APP_URL}/search?q={search_term_string}`,
    },
    'query-input': 'required name=search_term_string',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <head>
        {/* Tell the browser this page is intentionally dark-themed so it
            doesn't auto-invert form controls or "fix" white surfaces. */}
        <meta name="color-scheme" content="dark" />
        {/* Lock Dark Reader / similar extensions out — they invert white
            CTAs to dark and break the brand. */}
        <meta name="darkreader-lock" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: safeJsonLd(organizationSchema) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: safeJsonLd(softwareSchema) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: safeJsonLd(websiteSchema) }}
        />
      </head>
      <body className="overflow-x-hidden bg-black antialiased">
        <AmplitudeAnalytics />
        <ErrorBoundaryWrapper>
          {children}
          <CommandPalette />
        </ErrorBoundaryWrapper>
      </body>
    </html>
  )
}






































































































































































































































































































































































































































































































































































































