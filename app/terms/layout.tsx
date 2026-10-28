import { Metadata } from 'next'
import { pageMetadata } from '@/lib/seo/metadata'

export const metadata: Metadata = pageMetadata({
  title: 'Terms of Service',
  description:
    'Backenly Terms of Service. Read about acceptable use, your rights, platform guarantees, and how we handle your data and workspaces.',
  path: '/terms',
  social: { description: 'Backenly Terms of Service: acceptable use, rights, and platform guarantees.' },
})

export default function TermsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
