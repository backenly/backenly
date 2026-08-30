/**
 * @jest-environment jsdom
 */

/**
 * Analytics posture: what the browser SDK is allowed to collect.
 *
 * This component used to call `initAll()` from `@amplitude/unified` with
 * `sessionReplay: { sampleRate: 1 }` and `autocapture: true`, mounted in the
 * root layout — so 100% session replay plus element-interaction and network
 * capture ran over the authenticated console at /app/*, undisclosed. These
 * tests pin the corrected posture so it cannot regress silently.
 *
 * The structural guarantee — that the replay plugin is not a dependency at all
 * and therefore cannot be imported — is enforced by
 * scripts/verify-analytics-posture.ts, which runs in the build. This file
 * covers the runtime call shape.
 *
 * The component initializes ONCE per browser session by design (a module-level
 * flag that survives Fast Refresh), so this suite mounts once and asserts
 * against that single captured call. Re-requiring the module per test to reset
 * the flag would hand the component a second copy of React and break hooks;
 * the failure path is covered in amplitude-resilience.test.tsx, which gets a
 * fresh module registry by being a separate file.
 */

import React from 'react'
import { render } from '@testing-library/react'

// jest.mock factories may only reference out-of-scope variables whose names
// begin with `mock` — the hoist plugin enforces this statically.
const mockInit = jest.fn()
const mockInitAll = jest.fn()

jest.mock('@amplitude/analytics-browser', () => ({
  __esModule: true,
  init: (...args: unknown[]) => mockInit(...args),
  // Not part of this package's surface. Spied so that an edit which reaches
  // back for the unified SDK's entry point fails here loudly rather than
  // quietly reintroducing session replay.
  initAll: (...args: unknown[]) => mockInitAll(...args),
}))

const { AmplitudeAnalytics } = require('@/components/app/AmplitudeAnalytics')

/** Options passed to init() on the one call the component makes. */
let options: any

beforeAll(async () => {
  render(React.createElement(AmplitudeAnalytics))
  // A second mount, to prove the once-per-session guard holds.
  render(React.createElement(AmplitudeAnalytics))
  // Let the dynamic import() inside useEffect settle.
  await new Promise((resolve) => setTimeout(resolve, 0))
  options = mockInit.mock.calls[0]?.[1]
})

describe('AmplitudeAnalytics — collection posture', () => {
  it('initializes analytics exactly once, across two mounts', () => {
    expect(mockInit).toHaveBeenCalledTimes(1)
  })

  it('never calls initAll — that entry point loads the session replay plugin', () => {
    expect(mockInitAll).not.toHaveBeenCalled()
  })

  it('never passes a sessionReplay option', () => {
    expect(options).not.toHaveProperty('sessionReplay')
    expect(JSON.stringify(options)).not.toMatch(/sessionReplay/i)
  })

  it('passes autocapture as an object, never the boolean', () => {
    // `autocapture: true` short-circuits every capability gate in the SDK
    // (default-tracking.js: `if (typeof autocapture === 'boolean') return
    // autocapture`), enabling the five options that default to false.
    expect(typeof options.autocapture).toBe('object')
  })

  it('enables page views and sessions', () => {
    expect(options.autocapture.pageViews).toBe(true)
    expect(options.autocapture.sessions).toBe(true)
  })

  it.each([
    'attribution',
    'elementInteractions',
    'formInteractions',
    'fileDownloads',
    'frustrationInteractions',
    'networkTracking',
    'webVitals',
    'performanceTracking',
  ])('explicitly disables %s', (flag) => {
    // Explicit `false`, not merely absent: an upstream default change must not
    // be able to widen what we collect.
    expect(options.autocapture[flag]).toBe(false)
  })

  it('enables nothing beyond the two intended options', () => {
    const enabled = Object.entries(options.autocapture)
      .filter(([, value]) => value !== false)
      .map(([key]) => key)
      .sort()
    expect(enabled).toEqual(['pageViews', 'sessions'])
  })
})
