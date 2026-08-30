import Link from 'next/link'
import { Mail, ShieldCheck } from 'lucide-react'
import { SiteShell } from '@/components/site/SiteShell'
import { Card, PageHero, Section, SecondaryButton, Tag } from '@/components/site/kit'

type PrivacySection = {
  id: string
  title: string
  content: string
  list?: string[]
  extra?: string
  subsections?: { label: string; items: string[] }[]
}

const summary = [
  "We do not sell your data",
  'Your project data is isolated by design',
  'OpenAI is used only to provide AI features',
  'Payments are handled by Paddle',
  'Infrastructure is hosted on Hetzner',
  'You can request deletion of your data',
]

const sections: PrivacySection[] = [
  {
    id: '1',
    title: 'Who We Are',
    content:
      'Backenly operates the backenly.com platform, an autonomous backend platform for developers and product teams. This Privacy Policy explains how we collect, use, store, and protect personal information when you use our website and services.',
  },
  {
    id: '2',
    title: 'Information We Collect',
    content: 'We collect the following categories of information:',
    subsections: [
      {
        label: 'Account information',
        items: ['Name and email address', 'Password hashes', 'Profile preferences and settings'],
      },
      {
        label: 'Project and usage data',
        items: [
          'Projects you create and their configurations',
          'Database schemas and API definitions generated with AI',
          'API key metadata and hashed keys',
          'AI conversation history for project context',
        ],
      },
      {
        label: 'Technical data',
        items: [
          'IP address and browser or device type',
          'Pages visited, features used, and time spent',
          'Error logs and diagnostic information',
          'Performance metrics and request latency',
        ],
      },
      {
        label: 'Payment data',
        items: [
          'Billing plan and subscription status',
          'Payment details processed by Paddle. We do not store raw card numbers.',
        ],
      },
    ],
  },
  {
    id: '3',
    title: 'How We Use Your Information',
    content: 'We use the information we collect to:',
    list: [
      'Provide, operate, and improve the Backenly platform',
      'Authenticate identity and secure accounts',
      'Process payments and manage subscriptions',
      'Generate backend configurations based on your instructions',
      'Send transactional emails and important notices',
      'Respond to support requests and resolve issues',
      'Analyze aggregate usage trends and prevent abuse',
      'Comply with legal obligations',
    ],
    extra:
      'We do not use your data to train AI models without explicit consent. Project data is used only to provide the Service to you.',
  },
  {
    id: '4',
    title: 'Multi-Tenant Data Isolation',
    content:
      'Backenly is architected with strong data isolation. Each project runs in a dedicated PostgreSQL schema named workspace_{projectId}. This means:',
    list: [
      'Project data is not stored in shared customer tables',
      'End users of your application are separate from platform users',
      'AI queries are scoped to your project only',
      'Cross-tenant data access is prevented by design',
    ],
  },
  {
    id: '5',
    title: 'Data Storage and Security',
    content: 'We implement security controls including:',
    list: [
      'TLS encryption for data in transit',
      'API keys hashed before storage',
      'Passwords hashed with bcrypt',
      'Project-scoped JWT secrets',
      'Restricted production access',
      'Regular security reviews and dependency updates',
    ],
    extra: 'Our infrastructure is hosted on Hetzner. We do not store data in the United States.',
  },
  {
    id: '6',
    title: 'Data Sharing and Third Parties',
    content: 'We do not sell personal information. We share data only in limited circumstances:',
    list: [
      'Paddle for payment processing',
      'OpenAI for AI backend generation requests',
      'Hetzner for infrastructure hosting',
      'Legal compliance when required by law or court order',
      'Business transfers with appropriate notice',
    ],
    extra: 'We require third-party processors to maintain appropriate data protection standards.',
  },
  {
    id: '7',
    title: 'Cookies and Tracking',
    content: 'We use minimal cookies and similar technologies:',
    list: [
      'Session cookies to keep you logged in',
      'Preference cookies to remember UI settings',
      'Privacy-respecting analytics for aggregate usage patterns',
    ],
    extra:
      'We do not use third-party advertising cookies or tracking pixels. Disabling cookies may affect core product features.',
  },
  {
    id: '8',
    title: 'Data Retention',
    content: 'We retain your data according to the following rules:',
    list: [
      'Active account data is retained while the account exists',
      'Cancelled account data is retained for 30 days before deletion',
      'AI conversation history is retained for the lifetime of the project',
      'Billing records are retained for seven years',
      'Logs and diagnostics are retained for up to 90 days',
    ],
  },
  {
    id: '9',
    title: 'Your Rights',
    content: 'Depending on your location, you may have rights to access, correct, delete, export, restrict, or object to processing of your personal data.',
    extra:
      'To exercise these rights, contact support@backenly.com. We will respond within 30 days.',
  },
  {
    id: '10',
    title: "Children's Privacy",
    content:
      'Backenly is not intended for users under 16 years of age. We do not knowingly collect personal information from children under 16.',
  },
  {
    id: '11',
    title: 'Changes to This Policy',
    content:
      'We may update this Privacy Policy periodically. We will notify you of material changes by email or a prominent notice within the Service.',
  },
  {
    id: '12',
    title: 'Contact Us',
    content:
      'If you have questions, concerns, or requests related to this Privacy Policy, contact support@backenly.com.',
  },
]

export default function PrivacyPage() {
  return (
    <SiteShell>
      <main className="relative z-20">
        <PageHero
          eyebrow="Legal"
          title="Privacy Policy"
          subtitle="We believe your data belongs to you. This policy explains what we collect, why we collect it, and how we keep it protected."
          proof={[
            { label: 'Last updated', value: 'March 28, 2026' },
            { label: 'Architecture', value: 'Workspace isolation' },
            { label: 'Contact', value: 'support@backenly.com' },
          ]}
        />

        <Section width="wide-prose" className="!pt-0">
          <div className="grid gap-8 lg:grid-cols-[320px_1fr]">
            <aside className="space-y-5 lg:sticky lg:top-8 lg:self-start">
              <Card>
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-md border border-emerald-300/20 bg-emerald-400/10">
                    <ShieldCheck className="h-5 w-5 text-emerald-300" />
                  </div>
                  <div>
                    <Tag>Privacy summary</Tag>
                    <p className="mt-2 text-sm text-zinc-400">The short version.</p>
                  </div>
                </div>
                <ul className="mt-5 space-y-3">
                  {summary.map((item) => (
                    <li key={item} className="flex gap-3 text-sm leading-6 text-zinc-400">
                      <span aria-hidden className="mt-2.5 h-1 w-1 shrink-0 rounded-full bg-zinc-600" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </Card>

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
                <PrivacyBlock key={section.id} section={section} />
              ))}
            </div>
          </div>
        </Section>

        <Section width="default" className="!pt-0">
          <Card className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-white">Privacy questions?</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                Email support@backenly.com for data access, deletion, or privacy requests.
              </p>
            </div>
            <SecondaryButton href="mailto:support@backenly.com" external>
              <Mail className="h-4 w-4" />
              Contact support
            </SecondaryButton>
          </Card>
          <div className="mt-6 flex flex-wrap gap-4 text-sm text-zinc-500">
            <Link href="/terms" className="hover:text-white">
              Terms of Service
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

function PrivacyBlock({ section }: { section: PrivacySection }) {
  return (
    <section id={`section-${section.id}`} className="rounded-lg border border-white/10 bg-white/[0.035] p-6">
      <div className="flex items-start gap-4">
        <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/10 bg-black/30 text-xs font-semibold text-zinc-400">
          {section.id}
        </span>
        <div>
          <h2 className="text-lg font-semibold text-white">{section.title}</h2>
          <p className="mt-3 text-sm leading-7 text-zinc-400">{section.content}</p>

          {section.subsections && (
            <div className="mt-5 grid gap-x-8 gap-y-5 border-t border-white/10 pt-5 md:grid-cols-2">
              {section.subsections.map((subsection) => (
                <div key={subsection.label}>
                  <h3 className="text-sm font-semibold text-zinc-200">{subsection.label}</h3>
                  <ul className="mt-3 space-y-2">
                    {subsection.items.map((item) => (
                      <li key={item} className="flex gap-3 text-sm leading-6 text-zinc-400">
                        <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-300" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}

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
