/**
 * Product Hunt's launch badge, in the footer of every marketing page.
 *
 * The founders asked for it on 2026-10-30, the day before the launch, with the
 * embed code from the launch's embed page (producthunt.com/posts/backenly-2/embed).
 * The dark theme is the one that belongs on this site: white on near-black, so
 * it adds no Product Hunt orange to a page whose only colour is violet. The
 * launch bar above the navbar keeps its own rule (no logo, no orange) and stays
 * a plain sentence; the badge lives in the footer, where Product Hunt suggests
 * one.
 *
 * Product Hunt draws the image and keeps its upvote count current, so the
 * markup is theirs as given: their embed link with its badge UTM parameters,
 * and a plain img for their SVG (the site's img-src allows https:). The README
 * carries the neutral theme of the same badge, which reads on GitHub's light
 * and dark modes alike.
 */
const BADGE_HREF =
  'https://www.producthunt.com/products/backenly-2?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-backenly-2'
const BADGE_SRC =
  'https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1297694&theme=dark&t=1793308135226'

export function ProductHuntBadge({ className = '' }: { className?: string }) {
  return (
    <a
      href={BADGE_HREF}
      target="_blank"
      rel="noopener noreferrer"
      className={`block w-fit rounded-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 ${className}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={BADGE_SRC}
        alt="Backenly - The autonomous backend for AI coding agents | Product Hunt"
        width={250}
        height={54}
        loading="lazy"
        decoding="async"
        className="block"
      />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}
