'use client'

import { LandingV7 } from '@/components/landing-v7/LandingV7'
import { SiteShell } from '@/components/site/SiteShell'

/** The landing page: components/landing-v7, inside the marketing shell. */
export default function LandingPage() {
  return (
    <SiteShell>
      <LandingV7 />
    </SiteShell>
  )
}
