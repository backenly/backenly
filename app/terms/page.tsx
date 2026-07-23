import Link from 'next/link'
import { Mail } from 'lucide-react'
import { SiteShell } from '@/components/site/SiteShell'
import { Card, PageHero, Section, SecondaryButton, Tag } from '@/components/site/kit'

type LegalSection = {
  id: string
  title: string
  content: string
  list?: string[]
  extra?: string
}

const sections: LegalSection[] = [
  {
    id: '1',
    title: 'Acceptance of Terms',
    content:
      'By accessing or using Backenly at backenly.com, you agree to be bound by these Terms of Service. If you do not agree to these Terms, you may not use the Service.',
  },
  {
    id: '2',
    title: 'Description of Service',
    content:
      'Backenly is an autonomous backend platform that lets developers, founders, and product teams build, manage, and deploy production-grade backends using natural language. The Service includes:',
    list: [
      'AI-driven database and API generation',
      'PostgreSQL-backed data storage with multi-tenant isolation',
      'User authentication and JWT-based session management',
      'Realtime subscriptions via Server-Sent Events',
      'File storage, event triggers, webhooks, and deployment tooling',
      'Row-level security policies and rollback support',
    ],
  },
  {
    id: '3',
    title: 'Accounts and Registration',
    content: 'To use the Service, you must create an account. You agree to:',
    list: [
      'Provide accurate, current, and complete registration information',
      'Maintain the security of your password and account credentials',
      'Accept responsibility for activity under your account',
      'Notify us immediately of any unauthorized account access',
    ],
    extra:
      'We may terminate accounts that violate these Terms or that remain inactive for an extended period.',
  },
  {
    id: '4',
    title: 'Plans and Billing',
    content: 'Backenly offers Free, Pro, and Enterprise plans. Billing for paid plans is processed by Paddle.',
    list: [
      'Free: one permanent live project with limited monthly capacity',
      'Pro: additional capacity, custom domain, triggers, webhooks, rollback, team seats, and email support',
      'Enterprise: custom limits, SSO, priority support with an SLA, under an individual agreement',
    ],
    extra:
      'By subscribing to a paid plan, you authorize recurring billing. Fees are non-refundable except as stated in our Refund Policy. We may change pricing with reasonable notice.',
  },
  {
    id: '5',
    title: 'Acceptable Use',
    content: 'You agree not to use the Service to:',
    list: [
      'Violate any applicable law or regulation',
      'Infringe the intellectual property rights of any third party',
      'Transmit malware, viruses, or harmful code',
      'Conduct denial-of-service attacks or disrupt the Service',
      'Store or transmit illegal, offensive, or harmful content',
      'Reverse engineer or attempt to extract source code from the Service',
      'Resell or sublicense the Service without written permission',
      'Exceed usage limits in a way that degrades service for other users',
    ],
  },
  {
    id: '6',
    title: 'Data and Privacy',
    content:
      'Your use of the Service is governed by our Privacy Policy. You own the data you store in Backenly. You grant us a limited license to process that data solely to provide the Service.',
  },
  {
    id: '7',
    title: 'Intellectual Property',
    content:
      'The Backenly platform, AI systems, codebase, branding, and generated infrastructure templates are owned by Backenly and protected by intellectual property laws. You retain ownership of your application data and original content.',
  },
  {
    id: '8',
    title: 'Service Availability',
    content:
      'We strive to maintain high availability, but we do not guarantee uninterrupted service. We may perform scheduled maintenance, modify features, impose reasonable limits, or terminate access if these Terms are violated.',
  },
  {
    id: '9',
    title: 'Limitation of Liability',
    content:
      'To the maximum extent permitted by law, Backenly and its officers, directors, employees, and agents are not liable for indirect, incidental, special, consequential, or punitive damages arising from your use of the Service.',
  },
  {
    id: '10',
    title: 'Disclaimer of Warranties',
    content:
      'The Service is provided as is and as available, without warranties of any kind, express or implied, including implied warranties of merchantability, fitness for a particular purpose, or non-infringement.',
  },
  {
    id: '11',
    title: 'Termination',
    content:
      'You may cancel your account at any time. Upon termination, access ends according to your billing period and data retention policy. We may suspend or terminate accounts immediately for violations of these Terms.',
  },
  {
    id: '12',
    title: 'Governing Law',
    content:
      'These Terms are governed by applicable law. Disputes will be resolved individually through binding arbitration or courts of competent jurisdiction, unless prohibited by law.',
  },
  {
    id: '13',
    title: 'Changes to Terms',
    content:
      'We may update these Terms from time to time. We will notify you of material changes by email or a prominent notice in the Service.',
  },
  {
    id: '14',
    title: 'Contact',
    content:
      'If you have questions about these Terms, contact support@backenly.com. We aim to respond within two business days.',
  },
]

export default function TermsPage() {
  return (
    <SiteShell>
      <main className="relative z-20">
        <PageHero
          eyebrow="Legal"
          title="Terms of Service"
          subtitle="Please read these terms carefully before using Backenly. By using the service, you agree to be bound by them."
          proof={[
            { label: 'Last updated', value: 'March 28, 2026' },
            { label: 'Scope', value: 'Backenly platform' },
            { label: 'Contact', value: 'support@backenly.com' },
          ]}
        />

        <Section width="wide" className="!pt-0">
          <div className="grid gap-8 lg:grid-cols-[320px_1fr]">
            <aside className="lg:sticky lg:top-8 lg:self-start">
              <Card>
                <Tag>Contents</Tag>
                <div className="mt-5 grid gap-2">
                  {sections.map((section) => (
                    <a
                      key={section.id}
                      href={`#section-${section.id}`}
                      className="flex gap-3 rounded-md px-2 py-2 text-sm text-zinc-400 transition hover:bg-white/[0.04] hover:text-white"
                    >
                      <span className="w-5 shrink-0 text-zinc-600">{section.id}.</span>
                      <span>{section.title}</span>
                    </a>
                  ))}
                </div>
              </Card>
            </aside>

            <div className="space-y-5">
              {sections.map((section) => (
                <LegalBlock key={section.id} section={section} />
              ))}
            </div>
          </div>
        </Section>

        <Section width="default" className="!pt-0">
          <Card className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-white">Questions about these terms?</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                We reply to legal and account questions at support@backenly.com.
              </p>
            </div>
            <SecondaryButton href="mailto:support@backenly.com" external>
              <Mail className="h-4 w-4" />
              Contact support
            </SecondaryButton>
          </Card>
          <div className="mt-6 flex flex-wrap gap-4 text-sm text-zinc-500">
            <Link href="/privacy" className="hover:text-white">
              Privacy Policy
            </Link>
            <Link href="/refund-policy" className="hover:text-white">
              Refund Policy
            </Link>
          </div>
        </Section>
      </main>
    </SiteShell>
  )
}

function LegalBlock({ section }: { section: LegalSection }) {
  return (
    <section id={`section-${section.id}`} className="rounded-lg border border-white/10 bg-white/[0.035] p-6">
      <div className="flex items-start gap-4">
        <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/10 bg-black/30 text-xs font-semibold text-zinc-400">
          {section.id}
        </span>
        <div>
          <h2 className="text-lg font-semibold text-white">{section.title}</h2>
          <p className="mt-3 text-sm leading-7 text-zinc-400">{section.content}</p>
          {section.list && (
            <ul className="mt-4 space-y-2">
              {section.list.map((item) => (
                <li key={item} className="flex gap-3 text-sm leading-6 text-zinc-400">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-300" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          )}
          {section.extra && <p className="mt-4 text-sm leading-7 text-zinc-500">{section.extra}</p>}
        </div>
      </div>
    </section>
  )
}
