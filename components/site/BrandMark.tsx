'use client'

/**
 * Canonical wordmark + icon used in every marketing surface
 * (landing, pricing, features, auth pages).
 */
export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/backenly-icon-hd.svg"
      alt="Backenly"
      width={size}
      height={size}
      className="shrink-0"
    />
  )
}
