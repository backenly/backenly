import type { Metadata } from 'next'
import { Calendar, LifeBuoy, Mail, MessageSquare, ShieldCheck } from 'lucide-react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { SiteShell } from '@/components/site/SiteShell'
import {
  Card,
  CtaSection,
  InlineArrow,
  PageHero,
  PrimaryButton,
  SecondaryButton,
  Section,
  SectionIntro,
  Tag,
} from '@/components/site/kit'

const APP_URL = 'https://backenly.com'
const SUPPORT_EMAIL = 'support@backenly.com'
const FOUNDER_URL = 'https://calendly.com/adarsh-c-jose/30min'

export const metadata: Metadata = {
  title: 'Contact Backenly - Support, Sales, and Product Help',
  description:
    'Contact Backenly for product support, billing questions, production issues, sales conversations, and founder calls.',
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

const contactOptions = [
  {
    icon: LifeBuoy,
    title: 'Product support',
    body: 'Questions about projects, generated APIs, auth, storage, billing, or account access.',
    meta: 'Best first stop',
    href: `mailto:${SUPPORT_EMAIL}?subject=Backenly%20support%20request`,
    cta: 'Email support',
  },
  {
    icon: ShieldCheck,
    title: 'Production issue',
    body: 'Include the project name, endpoint, timestamp, and any trace ID shown in the dashboard.',
    meta: 'High signal reports',
    href: `mailto:${SUPPORT_EMAIL}?subject=Backenly%20production%20issue`,
    cta: 'Report issue',
  },
  {
    icon: Calendar,
    title: 'Founder call',
    body: 'For onboarding, partnerships, enterprise questions, or architecture discussions.',
    meta: '30 minute call',
    href: FOUNDER_URL,
    cta: 'Book a call',
  },
]

const supportChecklist = [
  'Account email or workspace URL',
  'Project name or project ID',
  'What you expected to happen',
  'What happened instead',
  'Relevant timestamp, endpoint, or trace ID',
]

export default function ContactPage() {
  return (
    <SiteShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(contactSchema) }}
      />
      <main className="relative z-20">
        <PageHero
          align="center"
          eyebrow="Contact"
          title="Get the right Backenly help, fast"
          subtitle="Support, billing, production issues, onboarding, and founder conversations all start here."
          actions={
            <>
              <PrimaryButton href={`mailto:${SUPPORT_EMAIL}`} external>
                <Mail className="h-4 w-4" />
                {SUPPORT_EMAIL}
              </PrimaryButton>
              <SecondaryButton href={FOUNDER_URL} external>
                <Calendar className="h-4 w-4" />
                Talk to founder
              </SecondaryButton>
            </>
          }
          proof={[
            { label: 'Support', value: SUPPORT_EMAIL },
            { label: 'Production', value: 'Trace IDs welcome' },
            { label: 'Response goal', value: 'Two business days' },
          ]}
        />

        <Section aria-label="Contact options" width="wide" className="!pt-0">
          <div className="grid gap-5 lg:grid-cols-3">
            {contactOptions.map((option) => {
              const Icon = option.icon
              const external = option.href.startsWith('http') || option.href.startsWith('mailto')

              return (
                <a
                  key={option.title}
                  href={option.href}
                  target={option.href.startsWith('http') ? '_blank' : undefined}
                  rel={option.href.startsWith('http') ? 'noopener noreferrer' : undefined}
                  className="group block h-full"
                >
                  <article className="flex h-full flex-col rounded-lg border border-white/10 bg-white/[0.035] p-6 transition group-hover:border-white/20 group-hover:bg-white/[0.055]">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex h-11 w-11 items-center justify-center rounded-md border border-white/10 bg-black/35">
                        <Icon className="h-5 w-5 text-zinc-200" />
                      </div>
                      <Tag>{option.meta}</Tag>
                    </div>
                    <h2 className="mt-6 text-xl font-semibold text-white">{option.title}</h2>
                    <p className="mt-3 flex-1 text-sm leading-6 text-zinc-400">{option.body}</p>
                    <p className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-zinc-200 group-hover:text-white">
                      {option.cta}
                      {external ? <InlineArrow /> : null}
                    </p>
                  </article>
                </a>
              )
            })}
          </div>
        </Section>

        <Section aria-label="Support details" width="wide">
          <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
            <SectionIntro
              eyebrow="Make support useful"
              title="Send the details that let us solve it on the first pass"
              body="Backenly is a backend platform, so the fastest support threads include concrete runtime context. A little precision up front saves a lot of back-and-forth."
            />

            <Card>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-md border border-emerald-300/20 bg-emerald-400/10">
                  <MessageSquare className="h-5 w-5 text-emerald-300" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-white">What to include</h2>
                  <p className="mt-1 text-sm text-zinc-500">Useful for support and production reports.</p>
                </div>
              </div>
              <ul className="mt-6 grid gap-3 sm:grid-cols-2">
                {supportChecklist.map((item) => (
                  <li key={item} className="flex gap-3 text-sm leading-6 text-zinc-400">
                    <span aria-hidden className="mt-2.5 h-1 w-1 shrink-0 rounded-full bg-zinc-600" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </Section>

        <CtaSection
          title="Need help choosing a plan?"
          body="Tell us what you are building, expected traffic, and whether the app is already live."
        >
          <PrimaryButton href={`mailto:${SUPPORT_EMAIL}?subject=Backenly%20plan%20question`} external>
            Email support
            <InlineArrow />
          </PrimaryButton>
          <SecondaryButton href="/pricing">View pricing</SecondaryButton>
        </CtaSection>
      </main>
    </SiteShell>
  )
}
