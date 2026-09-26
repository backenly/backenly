/** "just now", "4m ago", "3h ago", "2d ago". Relative to the reader's clock, at render time. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ''
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000))
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86_400)}d ago`
}
