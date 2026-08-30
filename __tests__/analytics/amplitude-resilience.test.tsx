/**
 * @jest-environment jsdom
 */

/**
 * Analytics must never be able to break the app.
 *
 * The SDK is loaded through a dynamic import inside useEffect, and the import
 * can fail for reasons that have nothing to do with us — an ad blocker, an
 * offline client, a chunk that 404s after a deploy. This component is mounted
 * in the root layout, so an unhandled rejection here would surface on every
 * page of the site.
 *
 * Separate file rather than a case in amplitude-config.test.tsx: the component
 * initializes once per module instance, so testing the failure path needs a
 * module registry where it has not already succeeded. A file boundary gives
 * that cleanly, where jest.resetModules() would also hand the component a
 * second copy of React and break its hooks.
 */

import React from 'react'
import { render } from '@testing-library/react'

jest.mock('@amplitude/analytics-browser', () => {
  throw new Error('simulated chunk load failure')
})

const { AmplitudeAnalytics } = require('@/components/app/AmplitudeAnalytics')

describe('AmplitudeAnalytics — resilience', () => {
  it('renders and throws nothing when the SDK fails to load', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => render(React.createElement(AmplitudeAnalytics))).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The failure is swallowed deliberately, but it is still reported.
    expect(consoleError).toHaveBeenCalledWith(
      'Amplitude failed to initialize',
      expect.any(Error),
    )
    consoleError.mockRestore()
  })
})
