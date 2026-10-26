'use client'

import { EvolutionScene } from './EvolutionScene'
import { CONTAINER, SECTION, SECTION_BODY_GAP, SECTION_TITLE } from './shared'

/* ─────────────────────────────────────────────────────────────
   Restructuring: the Architecture Evolution Engine (lib/evolution-engine,
   lib/structural-evolution). Set right after self-healing, in the same
   system (./shared): the same two-tone title, no eyebrow, and the scene in
   a BentoCell (./EvolutionScene).

   The two titles are a pair on purpose. Self-healing keeps a backend
   working; architecture evolution keeps it well-shaped (AGENTS.md), so one
   section says the backend repairs itself and this one says the schema
   restructures itself. "Schema", not "backend": the engine's one installed
   primitive is structural extraction (lib/evolution-engine/installed.ts),
   a change to tables, and semantic redesigns are never run (policy.ts).
   The continuation keeps the claim exact: Backenly finds the second job and
   carries the whole move out on its own, but only after a person approves,
   and apps that use the table keep working throughout
   (lib/structural-evolution/words.ts). It never says "zero downtime", and
   it never says the old columns go: removing them is a person's step.
───────────────────────────────────────────────────────────── */

export function EvolutionV7() {
  return (
    <section id="restructuring" aria-labelledby="restructuring-heading" className={`${SECTION} scroll-mt-[92px] font-light`}>
      <div className={CONTAINER}>
        <div>
          <h2 id="restructuring-heading" className={SECTION_TITLE}>
            Your schema restructures itself.{' '}
            <span className="text-zinc-500">
              When a table starts doing two jobs, Backenly separates them once you approve, and your apps keep working.
            </span>
          </h2>
        </div>
        <div className={SECTION_BODY_GAP}>
          <EvolutionScene />
        </div>
      </div>
    </section>
  )
}
