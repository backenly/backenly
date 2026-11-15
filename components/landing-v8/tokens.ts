/* ─────────────────────────────────────────────────────────────
   Landing v8 tokens (2026-11-14). One system for the page:

     ground     #08090a, the shell's own black, so header, page and footer
                meet without a seam
     ink        white headings, zinc-400 text, zinc-500 meta
     light      the hero's glass light is the one bright thing on the page;
                everything else is flat
     accent     Backenly's violet stays in the logo and the console's own
                small marks, nowhere else

   SIZES ARE px: app/globals.css sets the root font-size to 13px and redefines
   several margin utilities, so every size here is an explicit px value.
───────────────────────────────────────────────────────────── */

/** The page's container: the shell's 100rem (1300px here), so every edge lines up with the logo. */
export const WRAP = 'mx-auto w-full max-w-[100rem] px-5 sm:px-6'

/** Display type: the hero and the closing. Medium weight, tight, no gradient. */
export const DISPLAY = 'font-medium tracking-[-0.045em] text-white [text-wrap:balance]'

/** Section headings below the hero. */
export const H2 =
  'text-[32px] font-medium leading-[1.08] tracking-[-0.035em] text-white [text-wrap:balance] sm:text-[40px] lg:text-[48px] lg:leading-[1.04]'

/** The one line under a heading. */
export const LEAD = 'text-[16px] leading-[1.6] tracking-[-0.006em] text-zinc-400 [text-wrap:pretty] md:text-[18px] md:leading-[1.55]'

/** Space above every section below the hero. */
export const SECTION = 'relative pt-[96px] md:pt-[144px]'

const RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#08090a]'

/**
 * Buttons step up 1px on hover and sink on press (fine pointers only), with
 * the fill moving a step toward the ink. One pair for the whole page.
 */
export const BTN_PRIMARY =
  `group inline-flex h-[48px] items-center justify-center gap-[8px] whitespace-nowrap rounded-[6px] bg-white px-[20px] text-[15px] font-medium tracking-[-0.01em] text-black transition-[background-color,transform] duration-150 ease-out [@media(hover:hover)_and_(pointer:fine)]:hover:-translate-y-px [@media(hover:hover)_and_(pointer:fine)]:hover:bg-zinc-200 active:translate-y-px active:scale-[0.985] active:duration-75 ${RING}`

export const BTN_SECONDARY =
  `group inline-flex h-[48px] items-center justify-center gap-[8px] whitespace-nowrap rounded-[6px] border border-white/[0.14] bg-white/[0.04] px-[20px] text-[15px] font-medium tracking-[-0.01em] text-zinc-100 backdrop-blur-md transition-[background-color,border-color,transform] duration-150 ease-out [@media(hover:hover)_and_(pointer:fine)]:hover:-translate-y-px [@media(hover:hover)_and_(pointer:fine)]:hover:border-white/[0.24] [@media(hover:hover)_and_(pointer:fine)]:hover:bg-white/[0.08] active:translate-y-px active:scale-[0.985] active:duration-75 ${RING}`

/** A text link whose underline draws from the left on hover. */
export const TEXT_LINK =
  `relative inline-flex items-center gap-[6px] text-[15px] font-medium tracking-[-0.006em] text-zinc-200 transition-colors duration-150 after:absolute after:inset-x-0 after:-bottom-[3px] after:h-px after:origin-left after:scale-x-0 after:bg-current after:transition-transform after:duration-200 after:ease-out [@media(hover:hover)_and_(pointer:fine)]:hover:text-white [@media(hover:hover)_and_(pointer:fine)]:hover:after:scale-x-100 rounded-[2px] ${RING}`

/** The console's own surfaces, for the product pictures. */
export const CONSOLE = {
  /** A panel the size of the console's own cards. */
  PANEL: 'rounded-[12px] border border-white/[0.08] bg-[#0c0c0f]',
  /** The console's faint meta text (tailwind `faint`). */
  FAINT: 'text-faint',
  /** A resource tag (inspector kit `Tag`). */
  TAG: 'inline-flex h-[20px] items-center rounded-[5px] border border-white/[0.10] bg-white/[0.03] px-[6px] text-[11.5px] font-medium text-zinc-300',
} as const

/** The curve every entrance and travel uses: a strong ease-out, no overshoot. */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const
