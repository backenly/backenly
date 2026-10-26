'use client'

import { CtaV7 } from './CtaV7'
import { EvolutionV7 } from './EvolutionV7'
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

     1. Hero           the live console story
     2. Platform       the live bento of primitives, in its line-art figures
     3. Self-healing   the same minute on a typical backend and on Backenly
     4. Restructuring  one table doing two jobs, moved apart on approval
     5. Regions        the globe: five live regions
     6. FAQ            the live FAQ, answers corrected where the code disagrees
     7. Closing        the live ask over the horizon arc, into the footer

   The Connect and Restructuring sections added the same day, the
   "Governed changes" section and the closing billboard were all removed at
   the founders' request. Restructuring came back on 2026-10-25, once the
   Architecture Evolution Engine (#519) was live in production: the scene
   plays the engine's real ladder, in the self-healing scene's language.

   No page-wide film grain: its mix-blend overlay made the compositor re-blend
   the whole viewport on every scroll frame (the largest single cost the scroll
   benchmark found). The hero field carries its own dither.

───────────────────────────────────────────────────────────── */

export function LandingV7() {
  return (
    // Sections own their top padding only; the closing owns the page's bottom.
    <main id="main-content" className="relative overflow-x-clip bg-[#08090a] font-normal">
      <HeroV7 />
      <PrimitivesV7 />
      <SelfHealV7 />
      <EvolutionV7 />
      <RegionsV7 />
      <FaqV7 />
      <CtaV7 />
    </main>
  )
}
