/**
 * The Deploy page's readiness (report 86, rebuilt 2026-11-16): one line only
 * when every check that ran passed, checks that were skipped are not counted,
 * a failing warning is counted apart from what stops a publish, and each
 * failing check says where it is fixed.
 */
import { checkName, fixPageFor, readinessSummary, stopsPublish, type HeadlineCheck } from '@/components/deploy/readiness-headline'

const pass: HeadlineCheck = { status: 'pass', severity: 'blocking' }
const skip: HeadlineCheck = { status: 'skip', severity: 'warning' }
const warn: HeadlineCheck = { status: 'fail', severity: 'warning' }
const block: HeadlineCheck = { status: 'fail', severity: 'blocking' }

it('says all pass only when every check that ran passed, and leaves skipped checks out', () => {
  const s = readinessSummary([pass, pass, skip])
  expect(s.allPass).toBe(true)
  expect(s.ran).toBe(2)
  expect(s.line).toBe('All 2 checks pass. Publishing runs them again.')
})

it('counts a failing warning, and does not call the section passing', () => {
  const s = readinessSummary([pass, pass, warn])
  expect(s.allPass).toBe(false)
  expect(s.line).toBe('')
  expect(s.warnings).toBe(1)
  expect(s.blocking).toBe(0)
  expect(s.othersLine).toBe('2 other checks pass.')
})

it('counts what stops a publish apart from warnings', () => {
  const s = readinessSummary([pass, warn, block, block])
  expect(s.blocking).toBe(2)
  expect(s.warnings).toBe(1)
  expect(stopsPublish(block)).toBe(true)
  expect(stopsPublish(warn)).toBe(false)
  // An auto-fixable check stops a publish until its fix is applied.
  expect(stopsPublish({ status: 'fail', severity: 'auto-fixable' })).toBe(true)
  expect(stopsPublish({ status: 'fail', severity: 'auto-fixable', fixApplied: true })).toBe(false)
})

it('links a failing check to the page where it is fixed, and names the server check plainly', () => {
  expect(fixPageFor('rls_applied')).toEqual({ path: 'database', label: 'Database' })
  expect(fixPageFor('webhook_security')).toEqual({ path: 'webhooks', label: 'Webhooks' })
  expect(fixPageFor('env_vars')).toBeNull()
  expect(checkName({ id: 'env_vars', name: 'Required environment variables' })).toBe('Server configuration')
})
