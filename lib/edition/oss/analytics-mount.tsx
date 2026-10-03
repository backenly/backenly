/**
 * Backenly's internal analytics mount, as resolved WITHOUT the private overlay.
 *
 * `@cloud/analytics-mount` resolves here only when `lib/cloud/analytics-mount.tsx`
 * is absent, which means no Cloud overlay has been applied.
 *
 * ── Why the layout imports an alias ─────────────────────────────────────────
 *
 * app/layout.tsx is a single-copy PUBLIC file and the overlay may never
 * overwrite it, so it cannot import a component that exists only in Cloud. It
 * also cannot conditionally import one: this is a React Server Component tree,
 * and the mount has to be a real element in the returned JSX.
 *
 * So the layout imports a stable name, and the alias decides which
 * implementation that name resolves to at BUILD time. OSS gets this file and
 * renders nothing; composed Cloud gets the overlay's file and renders the real
 * initializer. The public layout is identical in both.
 *
 * Rendering null rather than omitting the element keeps the tree shape the same
 * in both editions, so nothing downstream has to care which one it got.
 */
export function CloudAnalyticsMount(): null {
  return null
}

export default CloudAnalyticsMount
