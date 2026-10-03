import type { Metadata } from 'next'
import { ArrowUpRight, Bug, Calendar, Mail, MessagesSquare, ShieldAlert, type LucideIcon } from 'lucide-react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { SiteShell } from '@/components/site/SiteShell'
import { ButtonLink, HorizonClose, JsonLd, Page, PageHero, Section } from '@/components/site/kit'
import { Reveal } from '@/components/site/Reveal'
import { StartButton } from '@/components/site/StartButton'
import { HEADING } from '@/components/site/tokens'
import { Composer } from './Composer'

const APP_URL = 'https://backenly.com'
const SUPPORT_EMAIL = 'support@backenly.com'
const FOUNDER_URL = 'https://calendly.com/adarsh-c-jose/30min'
const DISCORD_URL = 'https://discord.gg/6cHeYXDAu3'
const ISSUES_URL = 'https://github.com/backenly/backenly/issues'
const SECURITY_POLICY_URL = 'https://github.com/backenly/backenly/blob/main/SECURITY.md'

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

type Channel = { icon: LucideIcon; title: string; body: string; href: string; action: string }

/**
 * Every way to reach a person, with what each one is for and what to expect
 * back. The response times are the ones already published: two business days
 * for support (the Terms), 72 hours to acknowledge a security report
 * (SECURITY.md). Nothing here promises faster.
 */
const CHANNELS: Channel[] = [
  {
    icon: Mail,
    title: 'Email support',
    body: 'Projects, APIs, auth, storage, billing or account access. We aim to reply within two business days.',
    href: `mailto:${SUPPORT_EMAIL}`,
    action: SUPPORT_EMAIL,
  },
  {
    icon: Calendar,
    title: 'Talk to the founder',
    body: 'Thirty minutes for onboarding, architecture, partnerships or an Enterprise conversation.',
    href: FOUNDER_URL,
    action: 'Book a call',
  },
  {
    icon: ShieldAlert,
    title: 'Report a vulnerability',
    body: 'Email us with SECURITY in the subject, never a public issue. Acknowledged within 72 hours.',
    href: SECURITY_POLICY_URL,
    action: 'Read the security policy',
  },
  {
    icon: MessagesSquare,
    title: 'Community',
    body: 'Questions, ideas and what other people are building, on the Backenly Discord.',
    href: DISCORD_URL,
    action: 'Join the Discord',
  },
  {
    icon: Bug,
    title: 'Open-source bugs',
    body: 'A bug in the self-hosted platform, SDK or CLI that is not a security issue.',
    href: ISSUES_URL,
    action: 'Open a GitHub issue',
  },
]

export default function ContactPage() {
  return (
    <SiteShell>
      <JsonLd json={safeJsonLd(contactSchema)} />
      <Page>
        <PageHero
          trail={[{ label: 'Home', href: '/' }, { label: 'Contact' }]}
          title="Talk to the team that builds Backenly"
          lede="Support, billing, production issues and architecture questions all reach the same small team, and every message is read by a person."
        />

        <Section flush aria-label="Ways to reach us">
          <div className="grid gap-12 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-16">
            <Reveal>
              <Composer />
            </Reveal>

            <Reveal delay={0.06}>
              <h2 className={`text-[22px] text-white md:text-[24px] ${HEADING}`}>Or reach us directly</h2>
              <ul className="mt-6 flex flex-col">
                {CHANNELS.map((channel, index) => {
                  const ChannelIcon = channel.icon
                  const external = channel.href.startsWith('http')
                  return (
                    <li key={channel.title} className={index === 0 ? 'border-t border-white/[0.10]' : 'border-t border-white/[0.07]'}>
                      <a
                        href={channel.href}
                        target={external ? '_blank' : undefined}
                        rel={external ? 'noopener noreferrer' : undefined}
                        className="group grid grid-cols-[32px_minmax(0,1fr)] gap-4 py-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300"
                      >
                        <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.09] bg-white/[0.03] transition-colors duration-200 group-hover:border-white/20">
                          <ChannelIcon aria-hidden className="h-4 w-4 text-zinc-300" strokeWidth={1.75} />
                        </span>
                        <span className="min-w-0">
                          <span className={`block text-[16px] text-white ${HEADING}`}>{channel.title}</span>
                          <span className="mt-1.5 block text-[14px] leading-[1.6] text-zinc-400 [text-wrap:pretty]">{channel.body}</span>
                          <span className="mt-3 inline-flex items-center gap-1.5 text-[14px] font-medium text-zinc-300 transition-colors duration-200 group-hover:text-white">
                            {channel.action}
                            <ArrowUpRight
                              aria-hidden
                              className="h-3.5 w-3.5 transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                            />
                          </span>
                        </span>
                      </a>
                    </li>
                  )
                })}
              </ul>
            </Reveal>
          </div>
        </Section>

        <HorizonClose
          title="Or see it for yourself"
          lede="One free project, no credit card. Connect your agent and try it on a real backend."
        >
          <StartButton />
          <ButtonLink href="/resources" variant="secondary">
            Read the docs
          </ButtonLink>
        </HorizonClose>
      </Page>
    </SiteShell>
  )
}
