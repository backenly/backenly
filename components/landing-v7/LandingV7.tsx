'use client'

import { CtaV7 } from './CtaV7'
import { FaqV7 } from './FaqV7'
import { HeroV7 } from './HeroV7'
import { PrimitivesV7 } from './PrimitivesV7'
import { RegionsV7 } from './RegionsV7'
import { SelfHealV7 } from './SelfHealV7'

/* ─────────────────────────────────────────────────────────────
   Landing v7 (2026-10-14), built from the founders' reference set:
   Supabase, Appwrite, Neon, InsForge, Railway, Render, InstantDB,
   Modelence and Factory.

   2026-10-22, after the founders' mentor pointed at instacloud.com (an
   InsForge product): the hero's stills became the live console, which
   plays the whole product in one loop (the agent builds, Backenly heals,
   you approve).

     1. Hero          the live console story
     2. Platform      the live bento of primitives, in its line-art figures
     3. Self-healing  the same minute on a typical backend and on Backenly
     4. Regions       the globe: five live regions
     5. FAQ           the live FAQ, answers corrected where the code disagrees
     6. Closing       the live ask over the horizon arc, into the footer

   The Connect and Restructuring sections added the same day were removed
   at the founders' request; they are backed up at
   F:/landing-v7/alt-connect-evolve/. The stills hero and the composition
   before that day are at F:/landing-v7/alt-hero/. The "Governed changes"
   section (removed 2026-10-14) is at F:/landing-v7/alt-governed/, the
   closing billboard at F:/landing-v7/alt-closing/.

   No page-wide film grain: its mix-blend overlay made the compositor re-blend
   the whole viewport on every scroll frame (the largest single cost the scroll
   benchmark found). The hero field carries its own dither.

   A copy, not a replacement: the live page is origin/main app/page.tsx.
───────────────────────────────────────────────────────────── */

export function LandingV7() {
  return (
    // Sections own their top padding only; the closing owns the page's bottom.
    <main id="main-content" className="relative overflow-x-clip bg-[#08090a] font-normal">
      <HeroV7 />
      <PrimitivesV7 />
      <SelfHealV7 />
      <RegionsV7 />
      <FaqV7 />
      <CtaV7 />
    </main>
  )
}
