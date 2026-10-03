/**
 * Console design tokens: the dashboard's half of the design system.
 *
 * The landing page (app/page.tsx, components/site/tokens.ts) was rebuilt on
 * 2026-09-29 and settled the brand: a cool near-black ground, white primary
 * actions, violet as the one accent, Geist with tracking that tightens as the
 * size grows. The console rebuild of 2026-09-30 takes that language into the
 * product, so moving from backenly.com into a project does not feel like
 * walking into a different company's tool.
 *
 * The composition in one sentence: the chrome (top bar + sidebar) is one
 * continuous night surface that recedes, and the work sits on a lit canvas
 * inset into it, the way the landing page's hero film sits in its lit frame.
 *
 * Plain strings, no React, so server and client code can both import them.
 *
 * ── Rules that are easy to break by accident ────────────────────────────────
 *
 * 1. SIZES ARE `px`. app/globals.css sets the root font-size to 13px, so 1rem
 *    is 13px, and tailwind.config.ts only pins spacing steps 1, 2, 3, 4, 6, 8
 *    and 12 to px. Every other rem-based utility renders at 81%: `h-9` is
 *    29px, `h-11` is 36px, `rounded-xl` is 9.75px. Write `h-[36px]`.
 *
 * 2. NO UPPERCASE EYEBROWS. A tracked-out uppercase micro-label above every
 *    block is the loudest tell of a generated interface. Headings name their
 *    section in sentence case; group labels are 12px zinc-500 sentence case.
 *
 * 3. MONO IS FOR MACHINE TEXT. Code, SQL, ids, keys, endpoints, env names.
 *    Counts, dates, sizes and statuses are Geist with `tabular-nums`.
 *
 * 4. VIOLET IS AN ACCENT, NOT A FILL. Focus rings, links in prose, the lit
 *    canvas edge. Status is emerald / amber / rose, as a dot beside neutral
 *    text, never color alone.
 */

/* ── Surface ladder, dark → light ────────────────────────────────────────── */

/** Top bar + sidebar. The landing page ground, so the brand carries over. */
export const CHROME = 'bg-[#08090a]'
/** The lit work surface every page renders on. */
export const CANVAS = 'bg-[#0c0d0f]'
/** A list rail or side column inside an instrument, one step down. */
export const RAIL = 'bg-[#0a0b0d]'
/** Sunken: inputs, code blocks, read-only values. Same as the chrome. */
export const WELL = 'bg-[#08090a]'
/** A grouped panel inside the canvas. Used sparingly: most groups are hairlines. */
export const PLATE = 'bg-[#0f1012]'
/** Sticky table headers and pinned gutters. */
export const GRID_HEAD = 'bg-[#0e0f11]'
/** Row hover, opaque so sticky cells can match it. */
export const ROW_HOVER = 'bg-[#121316]'
/** Menus, popovers, dialogs. */
export const RAISE = 'bg-[#141518]'

/* ── Hairlines: three jobs, three weights ─────────────────────────────────── */

/** Divides items inside one group. */
export const RULE = 'border-white/[0.06]'
/** The outline of an actual object: a panel, an input, a card. */
export const EDGE = 'border-white/[0.08]'
/** A hovered or emphasised outline. */
export const EDGE_STRONG = 'border-white/[0.13]'

/* ── Elevation ────────────────────────────────────────────────────────────── */

/**
 * Floating layers only (menus, popovers, dialogs). A ring for the edge, two
 * shadows for ambient and direct light, and a one-pixel top highlight so the
 * layer reads as lit from above like the canvas it floats over.
 */
export const FLOAT =
  'shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_2px_8px_-2px_rgba(0,0,0,0.5),0_24px_64px_-16px_rgba(0,0,0,0.8),inset_0_1px_0_rgba(255,255,255,0.05)]'

/* ── Shape lock ───────────────────────────────────────────────────────────── */
/*   canvas 14 · panels and cards 10 · controls 7 · tags 5 · avatars round   */

export const R_CANVAS = 'rounded-[14px]'
export const R_PANEL = 'rounded-[10px]'
export const R_CONTROL = 'rounded-[7px]'
export const R_TAG = 'rounded-[5px]'

/* ── Type roles ───────────────────────────────────────────────────────────── */

/** Page title on document surfaces. */
export const T_PAGE = 'text-[22px] font-semibold leading-[28px] tracking-[-0.022em] text-zinc-50'
/** The sentence under a page title. */
export const T_LEDE = 'text-[14px] leading-[22px] tracking-[-0.006em] text-zinc-400'
/** A section heading inside a page. */
export const T_SECTION = 'text-[15px] font-semibold leading-[22px] tracking-[-0.012em] text-zinc-100'
/** A row or card heading. */
export const T_HEADING = 'text-[13px] font-medium leading-[20px] tracking-[-0.006em] text-zinc-100'
/** Default UI text. */
export const T_BODY = 'text-[13px] leading-[20px] text-zinc-300'
/** Secondary copy under a heading. */
export const T_MUTED = 'text-[13px] leading-[20px] text-zinc-400'
/** Meta, captions, table column names, helper text. */
export const T_META = 'text-[12px] leading-[16px] text-zinc-500'
/** Machine text: code, ids, keys, endpoints. */
export const T_CODE = 'font-mono text-[12px] leading-[18px]'
/** A number that sits in a column or updates in place. */
export const T_NUM = 'tabular-nums'

/* ── Layout ───────────────────────────────────────────────────────────────── */

/** Document surfaces read in one comfortable column. */
export const PAGE_WIDTH = 'mx-auto w-full max-w-[1200px]'
/** Horizontal gutter for document surfaces. */
export const PAGE_GUTTER = 'px-4 sm:px-6 lg:px-8'

/* ── Focus ────────────────────────────────────────────────────────────────── */

/** One focus treatment for every control in the console. */
export const FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0c0d0f]'
/** Focus for controls that sit flush in a row, where an offset would clip. */
export const FOCUS_INSET = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300/60'
