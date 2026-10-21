'use client'

import { LandingV7 } from '@/components/landing-v7/LandingV7'
import { SiteShell } from '@/components/site/SiteShell'

/**
 * Landing v7 preview (branch feat/landing-v7-references). The page that is
 * live on backenly.com is unchanged on origin/main.
 */
export default function LandingPage() {
  return (
    <SiteShell>
      <LandingV7 />
    </SiteShell>
  )
}
