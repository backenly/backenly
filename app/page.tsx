import type { Metadata } from 'next'
import { LandingV7 } from '@/components/landing-v7/LandingV7'
import { SiteShell } from '@/components/site/SiteShell'
import { JsonLd } from '@/components/site/kit'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { pageMetadata } from '@/lib/seo/metadata'
import { graph, softwareNode } from '@/lib/seo/schema'

// A server page around the client landing, so the home page can carry its own
// metadata: a client page cannot export any, and the home page's canonical
// used to sit on the root layout, where every other page inherited it.
export const metadata: Metadata = pageMetadata({
  title: 'Backenly: the open-source backend for AI coding agents',
  brandInTitle: true,
  description:
    'Claude Code, Cursor or Codex builds your backend over MCP: Postgres, REST APIs, auth, storage, realtime. Backenly verifies each change and keeps it running.',
  path: '/',
  social: {
    title: 'Backenly | The Autonomous Backend Platform',
    description:
      'Your coding agent builds it. Backenly keeps it running. Real Postgres, REST APIs, auth, storage and realtime over MCP, with every change verified and reversible. Open source.',
  },
})

/** The landing page: components/landing-v7, inside the marketing shell. */
export default function LandingPage() {
  return (
    <SiteShell>
      <JsonLd json={safeJsonLd(graph(softwareNode))} />
      <LandingV7 />
    </SiteShell>
  )
}
