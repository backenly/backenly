import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description:
    'Backenly Privacy Policy. Learn how we handle your data, protect workspace isolation, and comply with data protection standards including GDPR-aligned user rights.',
  robots: { index: true, follow: true },
  openGraph: {
    title: 'Privacy Policy | Backenly',
    description:
      'How Backenly handles your data — workspace isolation, retention, and your rights.',
    url: 'https://backenly.com/privacy',
    type: 'website',
  },
  alternates: {
    canonical: 'https://backenly.com/privacy',
  },
}

export default function PrivacyLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
