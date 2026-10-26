/* ─────────────────────────────────────────────────────────────
   The restructuring scene's story: when each beat happens, and the five
   steps a visitor can jump to, with what each one says. Its own module, with no
   three.js or GSAP in reach, so the card (./EvolutionScene) can read it on
   first paint while the scene itself (./evolution-engine) loads only with
   them, after the hero.
───────────────────────────────────────────────────────────── */

/* ── Timeline (seconds into a cycle) ───────────────────────────────── */

export const CYCLE = 27.4
/** The still frame shown when motion is reduced: the story told, every table in place. */
export const HOLD = 25.6

export const LOCK_AT = 4.9
export const LOCK_END = 6.4
export const REHEARSE_AT = 7.0
export const APPROVE_AT = 10.2
export const APPROVED_AT = 11.6
export const MOVE_AT = 12.6
export const SYNC_AT = 14.8
export const BACKFILL_AT = 15.6
export const BACKFILL_D = 2.3
export const VERIFY_AT = 18.2
export const OPEN_AT = 19.9
export const REVERSE_AT = 20.8
export const CONTRACT_AT = 22.9

export type ChapterId = 'notice' | 'rehearse' | 'approve' | 'move' | 'open'

/**
 * The five steps a visitor can jump to, as the card's step rail names them
 * (the hero's chapter rail, ./HeroV7). `rest` is the frame shown for a step
 * when nothing moves: its own last moment, with what it did still on screen.
 * The captions are the console's own claims (lib/structural-evolution/words.ts,
 * plan.ts) in one line each.
 */
export const CHAPTERS: { id: ChapterId; label: string; caption: string; at: number; rest: number }[] = [
  {
    id: 'notice',
    label: 'Notice',
    caption: 'Refunds are a second job inside orders, and changing them has locked the table.',
    at: 0,
    rest: 6.3,
  },
  {
    id: 'rehearse',
    label: 'Rehearse',
    caption: 'The whole change runs first on a copy of the real rows, then rolls back.',
    at: REHEARSE_AT,
    rest: 9.0,
  },
  {
    id: 'approve',
    label: 'Approve',
    caption: 'Nothing runs until you approve that exact plan. Agents can only read it.',
    at: APPROVE_AT,
    rest: 11.45,
  },
  {
    id: 'move',
    label: 'Move',
    caption: 'order_refunds is built beside orders, kept in step, filled and checked.',
    at: MOVE_AT,
    rest: 19.6,
  },
  {
    id: 'open',
    label: 'Open',
    caption: 'Old and new code both keep working. Nothing is removed, and undo stays available.',
    at: OPEN_AT,
    rest: HOLD,
  },
]

export function chapterAt(t: number) {
  let index = 0
  CHAPTERS.forEach((c, i) => {
    if (t >= c.at) index = i
  })
  return index
}

/** How many existing refunds the backfill copies (illustrative, like the card's caption says). */
export const REFUNDS = 4812
