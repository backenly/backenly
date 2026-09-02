import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Privacy Policy',
  // Describes the page rather than asserting a compliance posture. The previous
  // description claimed "GDPR-aligned user rights", which is a legal conclusion
  // nobody had reached, sitting in a meta tag where no reviewer looks.
  description:
    'What Backenly collects, why, which providers receive it, how long we keep it, and what happens when you ask us to delete it.',
  robots: { index: true, follow: true },
  openGraph: {
    title: 'Privacy Policy | Backenly',
    description:
      'What Backenly collects, which providers receive it, how long we keep it, and how deletion works.',
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
