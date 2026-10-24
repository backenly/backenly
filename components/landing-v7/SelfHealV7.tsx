'use client'

import { OperatedScene } from './OperatedScene'
import { CONTAINER, SECTION, SECTION_BODY_GAP, SECTION_TITLE } from './shared'

/* ─────────────────────────────────────────────────────────────
   Self-healing, and how Backenly differs from a typical backend platform.
   Set in the bento's system (./shared): the same two-tone title, no eyebrow,
   and the scene in a BentoCell with a CellTitle, the narration as its
   CellBody, and fact chips as the toggle (./OperatedScene).

   The title says what the scene shows (founders, 2026-10-15, on the old
   "Other backends flag problems" line: "not matching"): the backend repairs
   itself, safe fixes land on their own, risky changes wait. The comparison
   with a typical backend is the scene's toggle, not the headline.
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
          <OperatedScene />
        </div>
      </div>
    </section>
  )
}
