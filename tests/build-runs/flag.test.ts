/**
 * Phase 10 — flag gating
 * ----------------------
 * Locks in the contract that the build-run history feature defaults OFF and
 * the legacy `saveBuildMessages` (delete-and-reinsert) path stays in charge
 * unless `ENABLE_PHASE_10_BUILD_HISTORY` is explicitly set.
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals'

function reload() {
  jest.resetModules()
  return require('@/lib/config/flags') as typeof import('@/lib/config/flags')
}

describe('Phase 10 — ENABLE_PHASE_10_BUILD_HISTORY flag', () => {
  const ORIGINAL_SERVER = process.env.ENABLE_PHASE_10_BUILD_HISTORY
  const ORIGINAL_CLIENT = process.env.NEXT_PUBLIC_ENABLE_PHASE_10_BUILD_HISTORY

  beforeEach(() => {
    delete process.env.ENABLE_PHASE_10_BUILD_HISTORY
    delete process.env.NEXT_PUBLIC_ENABLE_PHASE_10_BUILD_HISTORY
  })

  afterEach(() => {
    if (typeof ORIGINAL_SERVER === 'string') process.env.ENABLE_PHASE_10_BUILD_HISTORY = ORIGINAL_SERVER
    else delete process.env.ENABLE_PHASE_10_BUILD_HISTORY
    if (typeof ORIGINAL_CLIENT === 'string') process.env.NEXT_PUBLIC_ENABLE_PHASE_10_BUILD_HISTORY = ORIGINAL_CLIENT
    else delete process.env.NEXT_PUBLIC_ENABLE_PHASE_10_BUILD_HISTORY
  })

  test('server flag defaults to false (legacy saveBuildMessages stays in charge)', () => {
    const { FLAGS } = reload()
    expect(FLAGS.ENABLE_PHASE_10_BUILD_HISTORY).toBe(false)
  })

  test('client flag defaults to false', () => {
    const { isPhase10BuildHistoryEnabledClient } = reload()
    expect(isPhase10BuildHistoryEnabledClient()).toBe(false)
  })

  test('server flag is true when env var is "true"', () => {
    process.env.ENABLE_PHASE_10_BUILD_HISTORY = 'true'
    const { FLAGS } = reload()
    expect(FLAGS.ENABLE_PHASE_10_BUILD_HISTORY).toBe(true)
  })

  test('client flag is true when NEXT_PUBLIC_* env var is "true"', () => {
    process.env.NEXT_PUBLIC_ENABLE_PHASE_10_BUILD_HISTORY = 'true'
    const { isPhase10BuildHistoryEnabledClient } = reload()
    expect(isPhase10BuildHistoryEnabledClient()).toBe(true)
  })

  test('any non-truthy value keeps the flag off', () => {
    process.env.ENABLE_PHASE_10_BUILD_HISTORY = 'false'
    process.env.NEXT_PUBLIC_ENABLE_PHASE_10_BUILD_HISTORY = ''
    const { FLAGS, isPhase10BuildHistoryEnabledClient } = reload()
    expect(FLAGS.ENABLE_PHASE_10_BUILD_HISTORY).toBe(false)
    expect(isPhase10BuildHistoryEnabledClient()).toBe(false)
  })

})
