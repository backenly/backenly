'use client'

/**
 * Canonical wordmark + icon used in every marketing surface
 * (landing, pricing, features, auth pages).
 */
/** `decorative`: the word "Backenly" sits beside the mark, so the image says nothing more (alt=""). */
export function BrandMark({ size = 26, decorative = false }: { size?: number; decorative?: boolean }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/backenly-icon-hd.svg"
      alt={decorative ? '' : 'Backenly'}
      width={size}
      height={size}
      className="shrink-0"
    />
  )
}
