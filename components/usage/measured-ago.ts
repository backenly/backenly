/**
 * When a measured reading was taken, as the Usage page says it: "measured
 * 3 min ago", or nothing for a reading from the last minute, which reads as
 * live. Database storage is measured, not counted (lib/usage/db-storage.ts).
 */
export function measuredAgo(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null
  const mins = Math.floor((now - new Date(iso).getTime()) / 60_000)
  if (!(mins >= 1)) return null
  if (mins < 60) return `measured ${mins} min ago`
  const hours = Math.floor(mins / 60)
  return `measured ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
}
