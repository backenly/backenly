import { Metadata } from 'next'
import { pageMetadata } from '@/lib/seo/metadata'

export const metadata: Metadata = pageMetadata({
  title: 'Pricing: Free, Pro and Enterprise plans',
  description:
    'Start free with no credit card, upgrade to Pro at $25 a month, or ask about Enterprise. Self-healing runs every minute on every plan. Self-hosting is free.',
  path: '/pricing',
  social: {
    title: 'Backenly Pricing: start free, scale when ready',
    description:
      'No credit card required. One permanent free project. Pro at $25/month when your product grows, and Enterprise for custom limits, SSO and an SLA.',
  },
})

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
