/**
 * Product Hunt's award badge: Backenly was #4 Product of the Day on its launch,
 * October 31, 2026. Beside the landing hero's buttons and in the footer of
 * every marketing page.
 *
 * Until launch day ended this was Product Hunt's "featured" badge, with the
 * upvote count, in the footer (founders, 2026-10-30) and then above the landing
 * headline (2026-10-31). On 2026-11-01, with the voting over, the founders
 * asked for the rank in its place.
 *
 * The dark theme, of the three Product Hunt offers: white on near-black, the
 * medal its one colour. The light theme is a white box with Product Hunt orange
 * type and the neutral one a white box with slate type; beside the hero's
 * white "Start free" either reads as a second primary button. The README
 * carries the neutral one, which reads on GitHub's light and dark modes alike.
 *
 * The image is Product Hunt's own SVG, byte for byte the file their embed code
 * points at (embed-image/v1/top-post-badge.svg, post 1297694, theme dark,
 * period daily), served from public/ rather than their API: the rank is final,
 * so there is no count to keep fresh, and from our origin it paints with the
 * page instead of after a request to a third party, which ad blockers may also
 * refuse. The link is their embed link, with its badge UTM parameters.
 */
const BADGE_HREF =
  'https://www.producthunt.com/products/backenly-2?embed=true&utm_source=badge-top-post-badge&utm_medium=badge&utm_campaign=badge-backenly-2'
const BADGE_SRC = '/media/product-hunt/top-post-badge-dark.svg'

export function ProductHuntBadge({
  className = '',
  imgClassName = '',
  eager = false,
}: {
  className?: string
  /** Sizes the badge; the box keeps Product Hunt's 250 by 54 proportions. */
  imgClassName?: string
  eager?: boolean
}) {
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
        alt="#4 Product of the Day on Product Hunt"
        width={250}
        height={54}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        className={`block ${imgClassName}`}
      />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}
