'use client'

import { HistoryBox, PlatformBox, RepairBox, RestructureBox, ScaleBox } from './BoxesV8'
import { CtaV8 } from './CtaV8'
import { FaqV8 } from './FaqV8'
import { HeroV8 } from './HeroV8'

/* ─────────────────────────────────────────────────────────────
   Landing v8 (2026-11-14), round 3. The founders, over the day: a line people
   understand at once, our purple, no borrowed backgrounds and no invented
   widgets, every section kept, far less text; then, with Blaxel's page as the
   reference, "make everything boxes except the hero, which is 100% wide and
   tall", and a box on scale and security (now "Five regions, every project isolated").

     Hero           full screen: announcement, the line, the connect command,
                    on a violet dawn (./DawnField)
     Platform       the v7 bento's parts, figures and all, in one box
     Autonomy       the approved self-repair film
     Restructuring  the approved restructuring film
     History        the restore, the page's one moment in the middle
     Scale          the globe, and what keeps projects apart and safe
     FAQ            v7's checked answers, all closed (on the page, no box)
     Closing        the violet horizon, rising once (full width, no box;
                    the footer meets the arc)

   Round 10: the Build box (the console screens under "Your agent builds
   it. Backenly runs it.") was removed by the founders.

   No section fades in on scroll; motion either answers a person or tells the
   product's story.
───────────────────────────────────────────────────────────── */

export function LandingV8() {
  return (
    <main id="main-content" className="relative overflow-x-clip bg-[#08090a] font-normal">
      <HeroV8 />
      <PlatformBox />
      <RepairBox />
      <RestructureBox />
      <HistoryBox />
      <ScaleBox />
      <FaqV8 />
      <CtaV8 />
    </main>
  )
}
