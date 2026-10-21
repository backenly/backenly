import type { Metadata } from 'next'
import { ArrowUpRight, Calendar, Mail, ShieldAlert, type LucideIcon } from 'lucide-react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { SiteShell } from '@/components/site/SiteShell'
import { ButtonLink, HorizonClose, JsonLd, Page } from '@/components/site/kit'
import { SpotlightPanel } from '@/components/site/SpotlightPanel'
import { StartButton } from '@/components/site/StartButton'
import { CONTAINER, DISPLAY, HEADING, PROSE_LINK, TEXT_LINK } from '@/components/site/tokens'

const APP_URL = 'https://backenly.com'
const SUPPORT_EMAIL = 'support@backenly.com'
const FOUNDER_URL = 'https://calendly.com/adarsh-c-jose/30min'
const DISCORD_URL = 'https://discord.gg/6cHeYXDAu3'
const ISSUES_URL = 'https://github.com/backenly/backenly/issues'

export const metadata: Metadata = {
  title: 'Contact Backenly - Support, Sales, and Product Help',
  description:
    'Contact Backenly for product support, billing questions, production issues, security reports, sales conversations, and founder calls.',
  alternates: { canonical: `${APP_URL}/contact` },
  openGraph: {
    title: 'Contact Backenly',
    description: 'Get help with Backenly support, billing, production issues, and onboarding.',
    url: `${APP_URL}/contact`,
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Contact Backenly',
    description: 'Support, billing, production help, and founder calls for Backenly.',
  },
}

const contactSchema = {
  '@context': 'https://schema.org',
  '@type': 'ContactPage',
  name: 'Contact Backenly',
  url: `${APP_URL}/contact`,
  mainEntity: {
    '@type': 'Organization',
    name: 'Backenly',
    url: APP_URL,
    email: SUPPORT_EMAIL,
    contactPoint: [
      {
        '@type': 'ContactPoint',
        contactType: 'customer support',
        email: SUPPORT_EMAIL,
        availableLanguage: ['en'],
      },
    ],
  },
}

type Path = { icon: LucideIcon; title: string; body: string; href: string; action: string }

/**
 * The three ways to reach a person, each with one action (2026-10-15,
 * founders: "short and crisp, not lots of links and information", read against
 * Linear's and Vercel's contact pages). The response times are the ones
 * already published: two business days for support (the Terms), 72 hours to
 * acknowledge a security report (SECURITY.md, which also names the address and
 * the SECURITY subject). Nothing here promises faster.
 */
const PATHS: Path[] = [
  {
    icon: Mail,
    title: 'Support',
    body: 'Projects, APIs, auth, storage, billing or account access. We aim to reply within two business days.',
    href: `mailto:${SUPPORT_EMAIL}`,
    action: SUPPORT_EMAIL,
  },
  {
    icon: Calendar,
    title: 'Talk to the founders',
    body: 'Thirty minutes for onboarding, architecture, partnerships or an Enterprise conversation.',
    href: FOUNDER_URL,
    action: 'Book a call',
  },
  {
    icon: ShieldAlert,
    title: 'Security',
    body: 'Report a vulnerability by email, never in a public issue. You get an acknowledgement within 72 hours.',
    href: `mailto:${SUPPORT_EMAIL}?subject=SECURITY`,
    action: 'Email a report',
  },
]

export default function ContactPage() {
  return (
    <SiteShell>
      <JsonLd json={safeJsonLd(contactSchema)} />
      <Page>
        {/* Just the title (founders, 2026-10-15: no company talk in the
            header). The cards say everything the page has to say. */}
        <section aria-labelledby="contact-title" className="relative isolate pb-[8px] pt-[48px] md:pt-[72px]">
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-[-220px] -z-10 h-[460px] w-[860px] max-w-none -translate-x-1/2 bg-[radial-gradient(closest-side,rgba(255,255,255,0.07),transparent)]"
          />
          <h1
            id="contact-title"
            className={`hero-enter bg-gradient-to-b from-white from-40% to-zinc-400 bg-clip-text pb-[4px] text-center text-[40px] text-transparent md:text-[52px] ${DISPLAY}`}
          >
            Contact us
          </h1>
        </section>

        <section aria-label="Ways to reach us" className="relative pt-[40px] md:pt-[56px]">
          <div className={CONTAINER}>
            <ul className="grid gap-[12px] md:grid-cols-3">
              {PATHS.map((path) => {
                const PathIcon = path.icon
                const external = path.href.startsWith('http')
                return (
                  <li key={path.title} className="min-w-0">
                    <SpotlightPanel as="div" className="h-full p-[24px] md:p-[28px]">
                      <PathIcon aria-hidden className="h-[18px] w-[18px] text-zinc-400" strokeWidth={1.75} />
                      <h2 className={`mt-[20px] text-[19px] text-white ${HEADING}`}>{path.title}</h2>
                      <p className="mt-[10px] flex-1 text-[15px] leading-[1.65] tracking-[-0.004em] text-zinc-400 [text-wrap:pretty]">
                        {path.body}
                      </p>
                      <a
                        href={path.href}
                        target={external ? '_blank' : undefined}
                        rel={external ? 'noopener noreferrer' : undefined}
                        className={`mt-[24px] w-fit ${TEXT_LINK}`}
                      >
                        {path.action}
                        <ArrowUpRight
                          aria-hidden
                          className="h-4 w-4 transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                        />
                      </a>
                    </SpotlightPanel>
                  </li>
                )
              })}
            </ul>

            <p className="mt-[28px] text-center text-[15px] leading-[1.7] text-zinc-400 [text-wrap:pretty]">
              For community questions, join the{' '}
              <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" className={PROSE_LINK}>
                Backenly Discord
              </a>
              . For a bug in the open-source platform, SDK or CLI, open a{' '}
              <a href={ISSUES_URL} target="_blank" rel="noopener noreferrer" className={PROSE_LINK}>
                GitHub issue
              </a>
              .
            </p>
          </div>
        </section>

        <HorizonClose
          title="Or see it for yourself"
          lede="One free project, no credit card. Connect your agent and try it on a real backend."
        >
          <StartButton />
          <ButtonLink href="/docs/database" variant="secondary">
            Read the docs
          </ButtonLink>
        </HorizonClose>
      </Page>
    </SiteShell>
  )
}
