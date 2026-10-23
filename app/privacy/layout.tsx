import { Metadata } from 'next'
import { pageMetadata } from '@/lib/seo/metadata'

export const metadata: Metadata = pageMetadata({
  title: 'Privacy Policy',
  // Describes the page rather than asserting a compliance posture. The previous
  // description claimed "GDPR-aligned user rights", which is a legal conclusion
  // nobody had reached, sitting in a meta tag where no reviewer looks.
  description:
    'What Backenly collects, why, which providers receive it, how long we keep it, and what happens when you ask us to delete it.',
  path: '/privacy',
  social: {
    description: 'What Backenly collects, which providers receive it, how long we keep it, and how deletion works.',
  },
})

export default function PrivacyLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
