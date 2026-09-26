'use client'

import { useSyncExternalStore } from 'react'
import { ArrowUpRight, X } from 'lucide-react'

/* ─────────────────────────────────────────────────────────────
   Announcement bar  ·  TEMPORARY, comes out after the Product Hunt launch

   A full-width strip ABOVE the navbar on every marketing page, in the
   shape the field uses for launch news (Supabase, Vercel, Linear): one
   centred sentence, one accent action, a dismiss control at the edge.
   It replaced the launch chip that sat above the hero headline, which
   cost the hero one of its four text elements and only showed on `/`.

   Flip SHOW_ANNOUNCEMENT to false to pull it in one edit. To remove it for
   good, delete this file, its call site in SiteShell, `ROUTES.productHunt`,
   and the `.launch-sweep` / `.announce-glyph` rules in app/globals.css.

   Rules carried over from the chip, still binding:

   - No Product Hunt brand mark and no hard date: that version was built
     and rejected by the founder. If a date is wanted, add it to MESSAGE.
   - No Product Hunt orange. Violet is the only accent: the glyph fields,
     the sweeping hairline and the action link. The badge stays the page's
     primary surface recipe, white on black.
   - It is not a signup CTA. It links out; `Sign up` in the nav stays the
     only auth door in the chrome.

   The bar scrolls away with the page; the navbar below it stays sticky.
   Dismissal is remembered per browser. The bar renders on the server and
   hides after mount for someone who dismissed it, so first paint never
   shifts for everyone else.
───────────────────────────────────────────────────────────── */

const SHOW_ANNOUNCEMENT = true

// Bump the suffix when the message changes, so a dismissal of the old news
// does not hide the new news.
const DISMISS_KEY = 'backenly:announcement:product-hunt-launch'

const MESSAGE = 'Backenly is launching soon on Product Hunt'
const ACTION = 'Follow the launch'

/*
 * Decorative bracket fields at each edge, a nod to what Backenly produces:
 * nested structure, opened and closed. Fixed strings, not random, so server
 * and client render the same markup. The right field is the left one
 * mirrored, so the two edges close what the left edge opened.
 */
const LEFT_ROWS = [
  '<<([{<<([{<<()>>}])>>}])>>{[(<',
  '{<<([{<<([{<>}])>>}])>>}<([{<<(',
  '{<([{{<([{<([])>}])>}}])>}[(<{[',
]

// Indices in each row that glow, staggered so they never fire together.
const GLOW = [
  [9, 22],
  [4, 17, 27],
  [12, 25],
]

const MIRROR: Record<string, string> = {
  '<': '>', '>': '<', '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{',
}
const RIGHT_ROWS = LEFT_ROWS.map((row) =>
  row.split('').reverse().map((c) => MIRROR[c] ?? c).join(''),
)

function GlyphField({ side }: { side: 'left' | 'right' }) {
  const rows = side === 'left' ? LEFT_ROWS : RIGHT_ROWS
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-y-0 hidden select-none flex-col justify-center font-mono text-[11px] leading-[13px] tracking-[0.12em] text-violet-400/45 lg:flex ${
        side === 'left'
          ? 'left-0 pl-4 [mask-image:linear-gradient(to_right,#000_40%,transparent)]'
          : 'right-0 items-end pr-4 [mask-image:linear-gradient(to_left,#000_40%,transparent)]'
      }`}
    >
      {rows.map((row, r) => {
        const glow = side === 'left' ? GLOW[r] : GLOW[r].map((i) => row.length - 1 - i)
        return (
          <span key={r} className="whitespace-pre">
            {row.split('').map((char, i) => {
              const at = glow.indexOf(i)
              return at === -1 ? (
                char
              ) : (
                <span
                  key={i}
                  className="announce-glyph text-violet-100"
                  style={{ animationDelay: `${(r * 3 + at) * 700}ms` }}
                >
                  {char}
                </span>
              )
            })}
          </span>
        )
      })}
    </div>
  )
}

// Dismissal lives in localStorage; this tiny store lets the component read it
// without a setState-in-effect round trip. The server snapshot is "not
// dismissed", so SSR markup always includes the bar.
const listeners = new Set<() => void>()

function readDismissed() {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    // Storage blocked (private mode, site data off): show the bar.
    return false
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function dismiss() {
  try {
    window.localStorage.setItem(DISMISS_KEY, '1')
  } catch {
    // Dismissal just won't persist past this page view.
  }
  dismissedThisView = true
  listeners.forEach((listener) => listener())
}

let dismissedThisView = false

export function AnnouncementBar({ href }: { href: string }) {
  const dismissed = useSyncExternalStore(
    subscribe,
    () => dismissedThisView || readDismissed(),
    () => false,
  )

  if (!SHOW_ANNOUNCEMENT || dismissed) return null

  return (
    <div
      role="region"
      aria-label="Announcement"
      className="relative z-50 w-full overflow-hidden border-b border-white/[0.08] bg-[#050507]"
    >
      {/* Soft violet wash behind the message, strongest at the centre. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_140%_at_50%_0%,rgba(139,92,246,0.14),transparent_70%)]"
      />
      {/* The signature violet hairline, sweeping, along the bottom edge. */}
      <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px overflow-hidden">
        <span className="absolute inset-0 bg-gradient-to-r from-transparent via-violet-400/40 to-transparent" />
        <span className="launch-sweep absolute inset-y-0 w-1/4 bg-gradient-to-r from-transparent via-violet-200 to-transparent" />
      </span>

      <GlyphField side="left" />
      <GlyphField side="right" />

      <div className="relative mx-auto flex min-h-[44px] max-w-[100rem] items-center justify-center px-12 py-2 sm:px-14">
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${MESSAGE}. ${ACTION}, opens in a new tab.`}
          className="group flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-[13px] font-medium text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-black sm:text-[14px]"
        >
          <span className="hidden rounded bg-white px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-[0.1em] text-black sm:inline-block">
            New
          </span>
          <span className="tracking-[-0.006em] text-white">{MESSAGE}</span>
          <span aria-hidden className="hidden h-1 w-1 rounded-full bg-zinc-600 sm:inline-block" />
          <span className="inline-flex items-center gap-1 text-violet-300 underline decoration-violet-400/40 underline-offset-4 transition-colors group-hover:text-violet-200 group-hover:decoration-violet-200">
            {ACTION}
            <ArrowUpRight
              aria-hidden
              className="h-3.5 w-3.5 transition-transform duration-200 group-hover:-translate-y-px group-hover:translate-x-px"
            />
          </span>
        </a>

        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss announcement"
          className="absolute right-3 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 sm:right-4"
        >
          <X aria-hidden className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
