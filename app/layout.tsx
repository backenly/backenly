import type { Metadata, Viewport } from 'next'
import './globals.css'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import { CommandPalette } from '@/components/app/CommandPalette'
// Resolved overlay-first: Backenly's analytics in composed Cloud, nothing in
// OSS. This layout is public and single-copy, so it cannot import a
// Cloud-only component directly; the alias is what makes one file work in
// both editions. See lib/edition/oss/analytics-mount.tsx.
import { CloudAnalyticsMount } from '@cloud/analytics-mount'
import { ErrorBoundaryWrapper } from './error-boundary-wrapper'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { OG_IMAGE, SITE_NAME, SITE_URL, X_HANDLE } from '@/lib/seo/metadata'
import { graph, organizationNode, websiteNode } from '@/lib/seo/schema'

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#000000',
  colorScheme: 'dark',
}

/**
 * The defaults every page starts from. A marketing page replaces the title,
 * description, canonical and social tags with its own (lib/seo/metadata.ts).
 *
 * There is deliberately no canonical here. A layout's canonical is inherited
 * by every page that sets none, and this one pointed sign-in screens, shared
 * reports and the 404 page at the home page. The home page sets its own.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Backenly | The Autonomous Backend Platform',
    template: '%s | Backenly',
  },
  description:
    'Your coding agent builds the backend over MCP; Backenly keeps it running: Postgres, REST APIs, auth, storage and realtime, with each schema change verified.',
  applicationName: SITE_NAME,
  authors: [{ name: SITE_NAME, url: SITE_URL }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
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
    siteName: SITE_NAME,
    title: 'Backenly | The Autonomous Backend Platform',
    description: 'Your coding agent builds it. Backenly keeps it running.',
    images: [OG_IMAGE],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Backenly | The Autonomous Backend Platform',
    description: 'Your coding agent builds it. Backenly keeps it running.',
    images: [OG_IMAGE.url],
    creator: X_HANDLE,
    site: X_HANDLE,
  },
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon.png', type: 'image/png', sizes: '32x32' },
      // Google shows a site's icon beside its results and wants one that is a
      // multiple of 48px; the 32px PNG is not.
      { url: '/icon-192.png', type: 'image/png', sizes: '192x192' },
    ],
    shortcut: '/favicon.ico',
    apple: '/apple-touch-icon.png',
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
        {/* Who publishes the site, once per page. The product itself is
            described on the home page (app/page.tsx). */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: safeJsonLd(graph(organizationNode, websiteNode)) }}
        />
      </head>
      <body className="overflow-x-hidden bg-black antialiased">
        <CloudAnalyticsMount />
        <ErrorBoundaryWrapper>
          {children}
          <CommandPalette />
        </ErrorBoundaryWrapper>
      </body>
    </html>
  )
}






































































































































































































































































































































































































































































































































































































