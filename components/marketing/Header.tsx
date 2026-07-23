'use client'

import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { Logo } from '@/components/Logo'

export function MarketingHeader() {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-dark-surface border-b border-dark-border">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center space-x-2">
          <Logo />
          <span className="text-xl font-semibold text-white">Backenly</span>
        </Link>
        
        <nav className="hidden md:flex items-center space-x-8">
          <Link href="/features" className="text-text-muted hover:text-white transition-colors">
            Features
          </Link>
          <Link href="/pricing" className="text-text-muted hover:text-white transition-colors">
            Pricing
          </Link>
<Link href="/blog" className="text-text-muted hover:text-white transition-colors">
            Blog
          </Link>
        </nav>
        
        <div className="flex items-center space-x-4">
          <Link href="/auth/signup">
            <Button variant="primary" size="md">
              Start Building →
            </Button>
          </Link>
        </div>
      </div>
    </header>
  )
}

