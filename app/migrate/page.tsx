import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ArrowRight, Import } from 'lucide-react'
import type { ReactNode } from 'react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { pageMetadata, SITE_URL } from '@/lib/seo/metadata'
import { graph, ORGANIZATION_ID } from '@/lib/seo/schema'
import { SiteShell } from '@/components/site/SiteShell'
import { ButtonLink, DataTable, JsonLd, Page, Steps } from '@/components/site/kit'
import { Faq } from '@/components/site/Faq'
import {
  GuideCode as Code,
  GuideDocument,
  GuideMetaDivider,
  GuideRows,
  GuideSection,
  GuideSubHeading,
  GUIDE_TEXT,
  guideDate,
} from '@/components/site/guide'
import { migrationPublished } from '@/components/migrate/flag'
import { MoveFigure } from '@/components/migrate/MoveFigure'
import { ConnectPreview } from '@/components/migrate/Welcome'
import {
  ACROSS,
  DESCRIPTION,
  FAQ,
  FIREBASE_NEEDS,
  FIREBASE_NOTES,
  GUIDE_PATH,
  GUIDE_UPDATED,
  STEPS,
  SUPABASE_NEEDS,
  SUPABASE_NOTES,
  TITLE,
  TOC,
} from './content'

/* ─────────────────────────────────────────────────────────────
   /migrate: the migration guide (2026-11-14).

   One page for moving a project in, from Supabase, Firebase or any
   Postgres, set as the site's other guides are (components/site/guide.tsx):
   the docs header, sections under linkable headings, "On this page" at xl,
   tables and dot rows. It is reached from the footer ("Migration guide"),
   the way Easel links its own; the landing page is left as it is. Both the
   page and the link wait for NEXT_PUBLIC_MIGRATION=published
   (components/migrate/flag.ts).

   The pictures are the product's own screens, not drawings: the move as it
   runs (components/migrate/MoveLedger, playing an example) and, in each
   source's section, that source's Connect panel from the first-run flow.
───────────────────────────────────────────────────────────── */

export const metadata: Metadata = pageMetadata({
  title: 'Migrate from Supabase or Firebase to Backenly',
  description: DESCRIPTION,
  path: GUIDE_PATH,
  type: 'article',
  modifiedTime: GUIDE_UPDATED,
})

const URL = `${SITE_URL}${GUIDE_PATH}`
const READ = GUIDE_TEXT
const START = '/auth/signup?start=move'
const FOUNDERS_HREF = 'https://calendly.com/adarsh-c-jose/30min'

const structuredData = graph(
  {
    '@type': 'TechArticle',
    headline: TITLE,
    description: DESCRIPTION,
    datePublished: GUIDE_UPDATED,
    dateModified: GUIDE_UPDATED,
    author: { '@id': ORGANIZATION_ID },
    publisher: { '@id': ORGANIZATION_ID },
    url: URL,
    mainEntityOfPage: { '@type': 'WebPage', '@id': URL },
  },
  {
    '@type': 'FAQPage',
    mainEntity: FAQ.map((item) => ({ '@type': 'Question', name: item.q, acceptedAnswer: { '@type': 'Answer', text: item.a } })),
  },
)

function Part({ id, children }: { id: string; children: ReactNode }) {
  return (
    <GuideSection id={id} title={TOC.find((item) => item.id === id)!.label}>
      {children}
    </GuideSection>
  )
}

/** A product screen set into the reading column, at the size it is used. */
function Screen({ children }: { children: ReactNode }) {
  return <div className="my-[4px]">{children}</div>
}

function Across({ source, from }: { source: 'supabase' | 'firebase' | 'postgres'; from: string }) {
  return (
    <DataTable
      caption={`What moves from ${from} to Backenly`}
      columns={[`On ${from}`, 'On Backenly']}
      rows={ACROSS[source].map((row) => [row.have, row.becomes])}
      minWidth="min-w-[520px]"
    />
  )
}

export default function MigrationGuide() {
  if (!migrationPublished()) notFound()
  return (
    <SiteShell>
      <JsonLd json={safeJsonLd(structuredData)} />
      <Page>
        <GuideDocument
          icon={Import}
          title={TITLE}
          crumb="Migration guide"
          summary="Backenly moves a project in one click: its tables and rows, its users with their passwords, and its files. Your old project is only read, so your app keeps running there until you switch it over."
          meta={
            <>
              <span>Updated {guideDate(GUIDE_UPDATED)}</span>
              <GuideMetaDivider />
              <span>Supabase, Firebase and any Postgres</span>
            </>
          }
          toc={TOC}
          close="Sign up, choose Move an existing project, and connect Supabase or Firebase. Your project keeps its name."
          closeTitle="Move your project"
          closeActions={
            <>
              <ButtonLink href={START}>
                Move your project
                <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
              </ButtonLink>
              <ButtonLink href={FOUNDERS_HREF} variant="secondary">
                Talk to the founders
              </ButtonLink>
            </>
          }
        >
          <Part id="how">
            <p className={READ}>
              A move copies a project into a new Backenly project and checks it: every table is counted on the old side and the
              new, and the move is done only when the two counts match. Start one from the first screen after you sign up.
            </p>
            <Screen>
              <MoveFigure source="supabase" />
            </Screen>
            <Steps steps={STEPS} />
          </Part>

          <Part id="supabase">
            <GuideSubHeading>What you need</GuideSubHeading>
            <GuideRows items={SUPABASE_NEEDS} />
            <Screen>
              <ConnectPreview source="supabase" />
            </Screen>
            <GuideSubHeading>What comes across</GuideSubHeading>
            <Across source="supabase" from="Supabase" />
            <GuideSubHeading>Good to know</GuideSubHeading>
            <GuideRows items={SUPABASE_NOTES} />
          </Part>

          <Part id="firebase">
            <GuideSubHeading>What you need</GuideSubHeading>
            <GuideRows items={FIREBASE_NEEDS} />
            <Screen>
              <ConnectPreview source="firebase" />
            </Screen>
            <GuideSubHeading>What comes across</GuideSubHeading>
            <Across source="firebase" from="Firebase" />
            <GuideSubHeading>Good to know</GuideSubHeading>
            <GuideRows items={FIREBASE_NOTES} />
          </Part>

          <Part id="postgres">
            <p className={READ}>
              Paste a connection string from any host Backenly can reach: Neon, RDS, Railway, Render or your own server. Use a direct
              connection, not a pooler. A read-only user is enough.
            </p>
            <Screen>
              <ConnectPreview source="postgres" />
            </Screen>
            <Across source="postgres" from="Postgres" />
          </Part>

          <Part id="after">
            <GuideSubHeading>Approve the access rules</GuideSubHeading>
            <p className={READ}>
              Backenly rewrites row-level security policies and Security Rules as its own access rules and holds them for you. Until
              you approve them, only your server key can read or write the moved tables, so nothing is open while you check them.
            </p>
            <GuideSubHeading>Point your app at Backenly</GuideSubHeading>
            <p className={READ}>
              From Supabase, most supabase-js code keeps working: import <Code>createClient</Code> from{' '}
              <Code>@backenly/sdk/supabase</Code> instead, and pass it your Backenly project URL and key. Calls to{' '}
              <Code>rpc()</Code> are the exception. From Firebase, the app’s SDK calls change; your coding agent can make that change
              for you.
            </p>
            <GuideSubHeading>Rebuild what stayed behind</GuideSubHeading>
            <p className={READ}>
              Connect your agent over MCP and ask it to rebuild your Edge Functions or Cloud Functions as Backenly functions. Each
              change it makes is planned, checked and can be undone.
            </p>
            <GuideSubHeading>Switch when you are ready</GuideSubHeading>
            <p className={READ}>
              Your old project keeps running, untouched. Move again right before you switch, so the copy is fresh, then point your
              app at Backenly.
            </p>
          </Part>

          <Part id="questions">
            <Faq items={FAQ} defaultOpen={null} />
          </Part>
        </GuideDocument>
      </Page>
    </SiteShell>
  )
}
