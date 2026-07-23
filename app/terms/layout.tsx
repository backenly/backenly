import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Terms of Service',
  description:
    'Backenly Terms of Service. Read about acceptable use, your rights, platform guarantees, and how we handle your data and workspaces.',
  robots: { index: true, follow: true },
  openGraph: {
    title: 'Terms of Service | Backenly',
    description: 'Backenly Terms of Service — acceptable use, rights, and platform guarantees.',
    url: 'https://backenly.com/terms',
    type: 'website',
  },
  alternates: {
    canonical: 'https://backenly.com/terms',
  },
}

export default function TermsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
