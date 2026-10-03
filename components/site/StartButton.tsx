'use client'

import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { ROUTES } from '@/components/site/SiteShell'
import { PRIMARY_CTA, SECONDARY_CTA } from '@/components/site/tokens'
import { useUserSession } from '@/lib/hooks/useUserSession'

/**
 * The site's one signup action, aware of the session: a signed-in visitor is
 * sent to the console instead of being asked to sign up again. The label is
 * the same everywhere ("Start free"), so the page never offers two different
 * names for one intent.
 */
export function StartButton({ variant = 'primary', label = 'Start free' }: { variant?: 'primary' | 'secondary'; label?: string }) {
  const { isLoggedIn } = useUserSession()

  return (
    <Link href={isLoggedIn ? ROUTES.app : ROUTES.signup} className={variant === 'primary' ? PRIMARY_CTA : SECONDARY_CTA}>
      {isLoggedIn ? 'Go to console' : label}
      <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
    </Link>
  )
}
