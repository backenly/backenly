import { Metadata } from 'next'
import { pageMetadata } from '@/lib/seo/metadata'

export const metadata: Metadata = pageMetadata({
  title: 'Refund Policy',
  description:
    'Backenly Refund Policy. Understand our fair billing practices, when refunds apply, and how to cancel your subscription.',
  path: '/refund-policy',
  social: { description: 'Backenly Refund Policy: fair billing, cancellations, and refund eligibility.' },
})

export default function RefundPolicyLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
