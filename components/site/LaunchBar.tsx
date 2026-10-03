import { ArrowUpRight } from 'lucide-react'

/**
 * The launch announcement: a band above the navbar on every marketing page.
 *
 * TEMPORARY, comes out after the Product Hunt launch. Flip SHOW_LAUNCH_BAR in
 * SiteShell to pull it in one edit. To remove it for good, delete this file,
 * its call site in SiteShell, `ROUTES.productHunt`, and the `.launch-sweep`
 * rules in app/globals.css.
 *
 * History: this was a chip in the landing hero. The founder moved it here on
 * 2026-09-30, which supersedes the earlier rejection of a bar above the navbar
 * (#138). The other founder decisions from the chip still hold:
 * - No Product Hunt brand mark and no hard date.
 * - Violet is the only colour. Never Product Hunt orange.
 * - The sweep is a CSS keyframe (see app/globals.css), off under reduced motion.
 * - It is an external link, not a second signup CTA.
 *
 * The whole band is one link, so on a phone the tap target is the full width
 * rather than a few words. It is not sticky: it scrolls away and the navbar
 * sticks at the top on its own, so every sticky offset on the site (68px, the
 * navbar's height) stays correct.
 */
export function LaunchBar({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative flex h-[40px] w-full items-center justify-center overflow-hidden bg-[#0b0b0f] px-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300"
    >
      {/* A violet glow rising from the lit edge, brighter on hover. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(36%_150%_at_50%_100%,rgba(139,92,246,0.24),transparent_70%)] opacity-80 transition-opacity duration-300 group-hover:opacity-100"
      />
      {/* The landing's lit hairline, with the launch sweep travelling along it. */}
      <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px overflow-hidden">
        <span className="absolute inset-0 bg-[linear-gradient(to_right,transparent,rgba(196,181,253,0.5)_28%,rgba(221,214,254,0.75)_50%,rgba(196,181,253,0.5)_72%,transparent)]" />
        <span className="launch-sweep absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-violet-100 to-transparent" />
      </span>

      <span className="relative flex min-w-0 items-center gap-3 text-[13.5px] tracking-[-0.006em]">
        <span className="shrink-0 rounded-[5px] bg-white px-1.5 py-[3px] text-[10.5px] font-semibold uppercase leading-none tracking-[0.08em] text-black">
          New
        </span>
        <span className="min-w-0 truncate text-zinc-300 transition-colors duration-200 group-hover:text-white">
          <span className="hidden sm:inline">Backenly is launching soon on Product Hunt</span>
          <span className="sm:hidden">Launching soon on Product Hunt</span>
        </span>
        <span aria-hidden className="hidden h-3.5 w-px shrink-0 bg-white/[0.16] sm:block" />
        <span className="hidden shrink-0 items-center gap-1 font-medium text-violet-200 transition-colors duration-200 group-hover:text-white sm:inline-flex">
          Follow the launch
          <ArrowUpRight
            aria-hidden
            className="h-3.5 w-3.5 transition-transform duration-200 group-hover:-translate-y-px group-hover:translate-x-px"
          />
        </span>
        <ArrowUpRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-violet-200 sm:hidden" />
      </span>
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}
