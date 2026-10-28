/**
 * The docs pages' share of the landing system (components/landing-v7/shared.tsx).
 *
 * Restated rather than imported: shared.tsx is a client module, and a server
 * page that imports a string from it receives a client reference, not the
 * string. Keep these in step with it.
 *
 * SIZES ARE px: the root font-size is 13px (components/site/tokens.ts).
 */

/** The landing's section-title type (shared.tsx TITLE_TYPE). */
export const TITLE_TYPE =
  'text-[30px] font-semibold leading-[1.12] tracking-[-0.03em] text-white sm:text-[36px] md:text-[42px] md:leading-[1.1]'

/**
 * A solid ink chip, the landing's figure chip (shared.tsx FIG.CHIP), for an
 * icon. Size, radius and icon colour are the caller's.
 */
export const ICON_CHIP = 'flex shrink-0 items-center justify-center border border-white/[0.09] bg-[#0b0b0e]'

/** Running prose on a docs page: a step up from marketing body, at a reading measure. */
export const READ = 'max-w-[68ch] text-[16px] leading-[1.75] tracking-[-0.006em] text-zinc-300 [text-wrap:pretty]'

/** The hairline between rows of one list (the landing FAQ's). */
export const ROW_RULE = 'border-white/[0.08]'
