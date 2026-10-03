import { SiteShell } from '@/components/site/SiteShell'
import { DataTable, Page, PageHero } from '@/components/site/kit'
import { LEGAL_TEXT, LegalBody, LegalFooter, LegalList, LegalSection } from '@/components/site/legal'

/**
 * The Refund Policy, set as a document like the Privacy Policy and the Terms.
 * The words are the published policy, unchanged; only the setting moved (the
 * red "danger" card is gone: a policy is not an alarm, and red was a second
 * accent colour on a violet-only site).
 */

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
    id: 'monthly-subscriptions',
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
    id: 'exceptional-circumstances',
    title: 'Exceptional circumstances',
    body: 'We review billing edge cases individually and will make things right when the issue is on our side.',
    items: [
      'Duplicate charges or billing errors',
      'Charges made after a valid cancellation request',
      'Significant service outage during your billing period',
    ],
  },
  {
    id: 'when-refunds-are-not-available',
    title: 'When refunds are not available',
    body: 'Refunds are generally unavailable for normal monthly subscription charges and account misuse.',
    items: [
      'Standard monthly subscription charges',
      'Accounts that violated our Terms of Service',
      'Plan overages, add-ons, misuse, fraud, or abuse',
      'Dissatisfaction alone after continued use of the service',
    ],
  },
]

export default function RefundPolicyPage() {
  const toc = [
    { id: 'core-stance', label: 'Cancel anytime. No lock-in.' },
    { id: 'by-plan', label: 'By plan' },
    ...policySections.map((s) => ({ id: s.id, label: s.title })),
  ]

  return (
    <SiteShell>
      <Page>
        <PageHero
          size="compact"
          trail={[{ label: 'Home', href: '/' }, { label: 'Refund Policy' }]}
          title="Refund Policy"
          lede="Straightforward billing terms for Backenly subscriptions: cancel anytime, keep access through the paid period, and contact us if something looks wrong."
        >
          <p className="mt-7 text-[14px] text-zinc-500">
            Last updated <span className="text-zinc-300">March 28, 2026</span>
          </p>
        </PageHero>

        <LegalBody toc={toc}>
          <LegalSection id="core-stance" title="Cancel anytime. No lock-in.">
            <p className={LEGAL_TEXT}>
              All Backenly subscriptions are monthly and non-refundable by default. You can cancel at
              any time from your billing settings. Your access continues through the end of the current
              billing period, then your account reverts to the free plan.
            </p>
          </LegalSection>

          <LegalSection id="by-plan" title="By plan">
            <DataTable
              caption="Refunds by plan"
              columns={['Plan', 'Price', 'Refunds']}
              minWidth="min-w-[480px]"
              rows={plans.map((plan) => [plan.name, plan.price, plan.note])}
            />
          </LegalSection>

          {policySections.map((section) => (
            <LegalSection key={section.id} id={section.id} title={section.title}>
              <p className={LEGAL_TEXT}>{section.body}</p>
              <LegalList items={section.items} />
            </LegalSection>
          ))}

          <LegalFooter
            current="refund"
            title="Have a billing question?"
            body="Include your account email, charge date, and a short description of what happened."
            email="support@backenly.com"
          />
        </LegalBody>
      </Page>
    </SiteShell>
  )
}
