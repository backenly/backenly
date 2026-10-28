'use client'

import { FeatureArt } from './FeatureArt'
import { healArt } from './art/heal-art'
import { CONTAINER, SECTION, SECTION_BODY_GAP, SECTION_TITLE } from './shared'

/* ─────────────────────────────────────────────────────────────
   Self-healing. Set in the bento's system (./shared): the same two-tone
   title, no eyebrow, and the body in a BentoCell.

   The title says what the film shows (founders, 2026-10-15, on the old
   "Other backends flag problems" line: "not matching"): the backend repairs
   itself, safe fixes land on their own, risky changes wait.

   2026-10-28 (founders: the grey, pencil-drawn scene read as generated; "use
   colors ... icons and symbols"): the body is a colour illustration that
   plays the five steps (./FeatureArt, ./art/heal-art). The comparison with a
   typical backend went with the old scene: the art shows what Backenly does.
───────────────────────────────────────────────────────────── */

export function SelfHealV7() {
  return (
    <section id="self-healing" aria-labelledby="heal-heading" className={`${SECTION} scroll-mt-[92px] font-light`}>
      <div className={CONTAINER}>
        <div>
          <h2 id="heal-heading" className={SECTION_TITLE}>
            Your backend repairs itself.{' '}
            <span className="text-zinc-500">
              Backenly checks it every minute, fixes what is safe on its own and holds risky changes for your approval.
            </span>
          </h2>
        </div>
        <div className={SECTION_BODY_GAP}>
          <FeatureArt make={healArt} note="An illustration, with an example store's tables." />
        </div>
      </div>
    </section>
  )
}
