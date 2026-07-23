import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Refund Policy',
  description:
    'Backenly Refund Policy. Understand our fair billing practices, when refunds apply, and how to cancel your subscription.',
  robots: { index: true, follow: true },
  openGraph: {
    title: 'Refund Policy | Backenly',
    description: 'Backenly Refund Policy — fair billing, cancellations, and refund eligibility.',
    url: 'https://backenly.com/refund-policy',
    type: 'website',
  },
  alternates: {
    canonical: 'https://backenly.com/refund-policy',
  },
}

export default function RefundPolicyLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
