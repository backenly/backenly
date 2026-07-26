import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Pricing — Free, Pro & Enterprise Plans',
  description:
    'Backenly pricing: free forever plan (1 project, no credit card), Pro at $25/month, Enterprise custom. Every plan includes autonomous self-healing — deterministic, and never billed to your AI credits.',
  keywords: [
    'Backenly pricing',
    'AI backend pricing',
    'backend as a service pricing',
    'free backend hosting',
    'BaaS free plan',
  ],
  openGraph: {
    title: 'Backenly Pricing — Start Free, Scale When Ready',
    description:
      'No credit card required. One permanent free project. Upgrade to Pro at $25/month when your product grows — Enterprise for custom limits, SSO, and an SLA.',
    url: 'https://backenly.com/pricing',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Backenly Pricing — Start Free, Scale When Ready',
    description: 'No credit card required. Free forever plan included.',
  },
  alternates: {
    canonical: 'https://backenly.com/pricing',
  },
}

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
