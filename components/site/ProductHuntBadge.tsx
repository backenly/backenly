'use client'

import { useState } from 'react'
import { useMinuteClock } from '@/lib/hooks/useMinuteClock'

/**
 * Product Hunt's launch badge, in the footer of every marketing page and above
 * the landing headline.
 *
 * The founders asked for it on 2026-10-30, the day before the launch, with the
 * embed code from the launch's embed page (producthunt.com/posts/backenly-2/embed).
 * The dark theme is the one that belongs on this site: white on near-black, so
 * it adds no Product Hunt orange to a page whose only colour is violet. (The
 * neutral theme is slate on a white box.) The launch bar above the navbar keeps
 * its own rule (no logo, no orange) and stays a plain sentence. On launch day
 * the founders asked for the badge in the hero too, for its upvote count.
 *
 * Product Hunt draws the image and its count, so the markup is theirs as given:
 * their embed link with its badge UTM parameters, and a plain img for their SVG
 * (the site's img-src allows https:). All but `t`. Product Hunt serves the image
 * cached for four hours (max-age=14400, measured 2026-10-31), keyed on the whole
 * URL, and their embed code fixes `t` at the moment it was copied, so every
 * visitor shared one copy and the count on it could be four hours old. Once the
 * visitor's clock is known, `t` moves every five minutes instead: visitors still
 * share one copy at a time, and an open page's count moves on its own. A fresh
 * copy is a miss in Product Hunt's cache, so if one fails to load, the badge
 * goes back to the embed's own URL (the copy their cache holds) for the rest of
 * the visit rather than leave a broken image in the hero. The README carries
 * the neutral theme of the same badge, which reads on GitHub's light and dark
 * modes alike.
 */
const BADGE_HREF =
  'https://www.producthunt.com/products/backenly-2?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-backenly-2'
const BADGE_SRC = 'https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1297694&theme=dark'
/** The `t` from Product Hunt's embed code, for the HTML, before the visitor's clock is known. */
const EMBED_T = 1793308135226
const REFRESH_MS = 5 * 60_000

export function ProductHuntBadge({ className = '', eager = false }: { className?: string; eager?: boolean }) {
  const now = useMinuteClock()
  const [failed, setFailed] = useState(false)
  const t = now === null || failed ? EMBED_T : now - (now % REFRESH_MS)

  return (
    <a
      href={BADGE_HREF}
      target="_blank"
      rel="noopener noreferrer"
      className={`block w-fit rounded-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 ${className}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${BADGE_SRC}&t=${t}`}
        alt="Backenly - The autonomous backend for AI coding agents | Product Hunt"
        width={250}
        height={54}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        onError={() => setFailed(true)}
        className="block"
      />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}
