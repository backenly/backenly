import Link from 'next/link'
import { AlertCircle, Clock3, Mail, RefreshCcw, ShieldCheck, XCircle } from 'lucide-react'
import { SiteShell } from '@/components/site/SiteShell'
import { Card, PageHero, Section, SecondaryButton, Tag } from '@/components/site/kit'

const plans = [
  {
    name: 'Free',
    price: '$0',
    note: 'No charge, so no refund is needed.',
  },
  {
    name: 'Pro',
    price: '$25/month',
    note: 'Monthly subscription charges are non-refundable by default.',
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    note: 'Refund terms are set in the individual agreement.',
  },
]

const policySections = [
  {
    icon: Clock3,
    title: 'Monthly subscriptions',
    body: 'All monthly subscription charges are final and non-refundable by default.',
    items: [
      'You may cancel at any time from billing settings',
      'Access continues until the end of the paid billing period',
      'After the period ends, the account downgrades to Free',
      'Unused days inside a billing cycle are not refunded',
    ],
  },
  {
    icon: RefreshCcw,
    title: 'Exceptional circumstances',
    body: 'We review billing edge cases individually and will make things right when the issue is on our side.',
    items: [
      'Duplicate charges or billing errors',
      'Charges made after a valid cancellation request',
      'Significant service outage during your billing period',
    ],
  },
  {
    icon: AlertCircle,
    title: 'When refunds are not available',
    body: 'Refunds are generally unavailable for normal monthly subscription charges and account misuse.',
    items: [
      'Standard monthly subscription charges',
      'Accounts that violated our Terms of Service',
      'Plan overages, add-ons, misuse, fraud, or abuse',
      'Dissatisfaction alone after continued use of the service',
    ],
    danger: true,
  },
]

export default function RefundPolicyPage() {
  return (
    <SiteShell>
      <main className="relative z-20">
        <PageHero
          eyebrow="Legal"
          title="Refund Policy"
          subtitle="Straightforward billing terms for Backenly subscriptions: cancel anytime, keep access through the paid period, and contact us if something looks wrong."
          proof={[
            { label: 'Last updated', value: 'March 28, 2026' },
            { label: 'Billing', value: 'Monthly subscriptions' },
            { label: 'Support', value: 'support@backenly.com' },
          ]}
        />

        <Section width="wide" className="!pt-0">
          <Card className="mb-8">
            <div className="flex gap-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-violet-300/20 bg-violet-400/10">
                <ShieldCheck className="h-5 w-5 text-violet-200" />
              </div>
              <div>
                <Tag>Core stance</Tag>
                <h2 className="mt-4 text-2xl font-semibold text-white">Cancel anytime. No lock-in.</h2>
                <p className="mt-3 max-w-3xl text-sm leading-7 text-zinc-400">
                  All Backenly subscriptions are monthly and non-refundable by default. You can
                  cancel at any time from your billing settings. Your access continues through the
                  end of the current billing period, then your account reverts to the free plan.
                </p>
              </div>
            </div>
          </Card>

          <div className="grid gap-4 md:grid-cols-3">
            {plans.map((plan) => (
              <article key={plan.name} className="rounded-lg border border-white/10 bg-white/[0.035] p-6">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase text-zinc-500">{plan.name}</p>
                    <p className="mt-3 text-2xl font-semibold text-white">{plan.price}</p>
                  </div>
                  <XCircle className="h-5 w-5 text-zinc-500" />
                </div>
                <p className="mt-4 text-sm leading-6 text-zinc-400">{plan.note}</p>
              </article>
            ))}
          </div>
        </Section>

        <Section width="wide">
          <div className="grid gap-5 lg:grid-cols-3">
            {policySections.map((section) => {
              const Icon = section.icon
              return (
                <article
                  key={section.title}
                  className={`rounded-lg border p-6 ${
                    section.danger
                      ? 'border-red-400/20 bg-red-400/[0.035]'
                      : 'border-white/10 bg-white/[0.035]'
                  }`}
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-md border border-white/10 bg-black/30">
                    <Icon className={`h-5 w-5 ${section.danger ? 'text-red-300' : 'text-zinc-200'}`} />
                  </div>
                  <h2 className="mt-5 text-lg font-semibold text-white">{section.title}</h2>
                  <p className="mt-3 text-sm leading-7 text-zinc-400">{section.body}</p>
                  <ul className="mt-5 space-y-2">
                    {section.items.map((item) => (
                      <li key={item} className="flex gap-3 text-sm leading-6 text-zinc-400">
                        <span
                          className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${
                            section.danger ? 'bg-red-300' : 'bg-violet-300'
                          }`}
                        />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </article>
              )
            })}
          </div>
        </Section>

        <Section width="default">
          <Card className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-white">Have a billing question?</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                Include your account email, charge date, and a short description of what happened.
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
            <Link href="/privacy" className="hover:text-white">
              Privacy Policy
            </Link>
            <Link href="/pricing" className="hover:text-white">
              Pricing
            </Link>
          </div>
        </Section>
      </main>
    </SiteShell>
  )
}
