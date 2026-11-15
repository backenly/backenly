import Image from 'next/image'

/* ─────────────────────────────────────────────────────────────
   The closing light: Backenly's painted dawn on the horizon (public/media/v8/
   light/dome.webp), shared by the landing's closing (CtaV8) and every subpage
   that ends on one (components/site/kit.tsx HorizonClose).

   Its crest sits 170px above the section's bottom edge, and the painting runs
   1240px further down, behind the footer. A page that ends on it sets
   SiteShell `footerLit`, which leaves the footer clear and clips the light at
   the page's end. Static: the founders asked for the light without a rise or
   fade (2026-11-15). The parent section must be `relative` and must not clip.
───────────────────────────────────────────────────────────── */

export function ClosingLight() {
  return (
    <>
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-[calc(100%-430px)] h-[1500px]">
        <Image src="/media/v8/light/dome.webp" alt="" width={1320} height={900} unoptimized className="absolute left-1/2 top-0 h-[1500px] w-[2200px] max-w-none -translate-x-1/2" />
        <div className="absolute left-1/2 top-[260px] h-[1400px] w-[2200px] -translate-x-1/2 rounded-[50%] border-t border-violet-100/60" />
      </div>
      {/* The grain sits beside the light, not inside its layer (a layer of its own would isolate it, and the grain would only grey the black), faded in from the top. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-[calc(100%-430px)] h-[1500px] bg-[url('/media/v8/light/grain.svg')] opacity-[0.28] mix-blend-soft-light [mask-image:linear-gradient(to_bottom,transparent,#000_220px)]"
      />
    </>
  )
}

/**
 * The same dawn held inside a framed box and dimmed (components/site/kit.tsx
 * CloseBox): a page that asked for less of the violet (founders, 2026-11-15)
 * ends on one quiet light instead of the full horizon. The box must be
 * `relative isolate overflow-hidden`; the crest sits 44px above its bottom.
 */
export function BoxDawn() {
  return (
    <>
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 opacity-[0.62]">
        <Image src="/media/v8/light/dome.webp" alt="" width={1320} height={900} unoptimized className="absolute left-1/2 top-[calc(100%-230px)] h-[1090px] w-[1600px] max-w-none -translate-x-1/2" />
        <div className="absolute left-1/2 top-[calc(100%-44px)] h-[1000px] w-[1600px] -translate-x-1/2 rounded-[50%] border-t border-violet-100/40" />
      </div>
      <span aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-[url('/media/v8/light/grain.svg')] opacity-[0.22] mix-blend-soft-light" />
    </>
  )
}
