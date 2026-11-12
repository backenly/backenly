/**
 * The Deploy page's readiness line (report 86): green only when every check
 * that ran passed, amber with a count when a warning failed, and checks that
 * were skipped are not counted.
 */
import { readinessHeadline, type HeadlineCheck } from '@/components/deploy/readiness-headline'

const pass: HeadlineCheck = { status: 'pass', severity: 'blocking' }
const skip: HeadlineCheck = { status: 'skip', severity: 'warning' }
const warn: HeadlineCheck = { status: 'fail', severity: 'warning' }
const block: HeadlineCheck = { status: 'fail', severity: 'blocking' }

it('is green only when every check that ran passed, and leaves skipped checks out', () => {
  expect(readinessHeadline([pass, pass, skip])).toEqual({ tone: 'operational', label: '2 of 2 passing' })
})

it('turns amber and counts a failing warning', () => {
  expect(readinessHeadline([pass, pass, warn])).toEqual({ tone: 'attention', label: '2 of 3 passing · 1 warning' })
  expect(readinessHeadline([pass, warn, warn])).toEqual({ tone: 'attention', label: '1 of 3 passing · 2 warnings' })
})

it('says how many block publishing', () => {
  expect(readinessHeadline([pass, warn, block, block])).toEqual({ tone: 'attention', label: '2 to clear' })
})
