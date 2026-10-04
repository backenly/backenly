import { SiteShell } from '@/components/site/SiteShell'
import { Page, PageHero } from '@/components/site/kit'
import { LEGAL_TEXT, LegalBody, LegalFooter, LegalList, LegalSection as Clause } from '@/components/site/legal'

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
    content: 'Backenly offers Free, Pro, and Enterprise plans. Payments for paid plans, and for usage beyond a plan, are processed by Stripe.',
    list: [
      'Free: one permanent live project with limited monthly capacity',
      'Pro: additional capacity, custom domain, triggers, webhooks, rollback, team seats, and email support',
      'Enterprise: custom limits, SSO, priority support with an SLA, under an individual agreement',
      'Usage beyond a plan: on Pro, usage past the included quotas is paid for in advance, and only after you set a monthly spend limit above zero. Setting or raising the limit requires confirmation from your account email and a payment of whatever your prepaid usage balance does not already cover. Usage past the quotas is charged at the rates published on the pricing page and drawn from that balance when each month closes; a month’s draw will not exceed the spending limit in effect when that month closes, or the balance. Unused balance carries over to later months. You can lower or remove the limit at any time.',
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

/**
 * Anchors stay `#section-N`: they are what external links to a clause already
 * point at. The words above are the Terms as published; only the setting moved.
 */
export default function TermsPage() {
  return (
    <SiteShell>
      <Page>
        <PageHero
          size="compact"
          trail={[{ label: 'Home', href: '/' }, { label: 'Terms of Service' }]}
          title="Terms of Service"
          lede="Please read these terms carefully before using Backenly. By using the service, you agree to be bound by them."
        >
          <p className="mt-7 text-[14px] text-zinc-500">
            Last updated <span className="text-zinc-300">October 3, 2026</span>
          </p>
        </PageHero>

        <LegalBody numbered toc={sections.map((section) => ({ id: `section-${section.id}`, label: section.title }))}>
          {sections.map((section) => (
            <Clause key={section.id} id={`section-${section.id}`} number={Number(section.id)} title={section.title}>
              <p className={LEGAL_TEXT}>{section.content}</p>
              {section.list && <LegalList items={section.list} />}
              {section.extra && <p className={LEGAL_TEXT}>{section.extra}</p>}
            </Clause>
          ))}

          <LegalFooter
            current="terms"
            title="Questions about these terms?"
            body="We reply to legal and account questions at support@backenly.com."
            email="support@backenly.com"
          />
        </LegalBody>
      </Page>
    </SiteShell>
  )
}
