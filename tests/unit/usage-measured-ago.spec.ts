/**
 * How the Usage page says when database storage was measured (report 108):
 * nothing for a reading from the last minute, minutes, then hours.
 */
import { measuredAgo } from '@/components/usage/measured-ago'

const NOW = Date.parse('2026-11-11T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

it('says nothing for a reading from the last minute, or none at all', () => {
  expect(measuredAgo(ago(30_000), NOW)).toBeNull()
  expect(measuredAgo(null, NOW)).toBeNull()
})

it('says minutes, then hours', () => {
  expect(measuredAgo(ago(3 * 60_000), NOW)).toBe('measured 3 min ago')
  expect(measuredAgo(ago(60 * 60_000), NOW)).toBe('measured 1 hour ago')
  expect(measuredAgo(ago(5 * 60 * 60_000), NOW)).toBe('measured 5 hours ago')
})
