/**
 * @jest-environment jsdom
 */
/**
 * COOKIE CONSENT GATES ANALYTICS (lib/consent.ts, components/site/ConsentGate.tsx)
 * ============================================================================
 * The root layout mounts the analytics initializer inside <ConsentGate>. What
 * that has to guarantee, and what this pins:
 *
 *   - nothing analytics-related renders before an explicit yes, or after a no;
 *   - a yes renders it at once, without a reload;
 *   - withdrawing a yes clears Amplitude's cookies and storage and reloads, so
 *     the SDK already in memory is gone;
 *   - a choice survives in the cookie, and one from an older version is
 *     ignored so the visitor is asked again;
 *   - Global Privacy Control is read as no.
 */
import { act, render, screen } from '@testing-library/react'
import { ConsentGate } from '@/components/site/ConsentGate'
import {
  analyticsAllowed,
  CONSENT_COOKIE,
  globalPrivacyControl,
  readConsent,
  saveConsent,
} from '@/lib/consent'

function clearCookies() {
  for (const part of document.cookie.split('; ')) {
    const name = part.split('=')[0]
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`
  }
}

const reload = jest.fn()

beforeAll(() => {
  Object.defineProperty(window, 'location', { value: { ...window.location, reload, protocol: 'http:', hostname: 'localhost' }, writable: true })
})

beforeEach(() => {
  clearCookies()
  window.localStorage.clear()
  reload.mockClear()
})

describe('consent record', () => {
  it('starts with no choice, and analytics not allowed', () => {
    expect(readConsent()).toBeNull()
    expect(analyticsAllowed()).toBe(false)
  })

  it('keeps a yes and a no', () => {
    saveConsent(true)
    expect(readConsent()?.analytics).toBe(true)
    expect(analyticsAllowed()).toBe(true)
    saveConsent(false)
    expect(readConsent()?.analytics).toBe(false)
    expect(analyticsAllowed()).toBe(false)
  })

  it('ignores a choice recorded under an older version, so the visitor is asked again', () => {
    document.cookie = `${CONSENT_COOKIE}=${encodeURIComponent(JSON.stringify({ version: 0, analytics: true }))}; Path=/`
    expect(readConsent()).toBeNull()
    expect(analyticsAllowed()).toBe(false)
  })

  it('reads Global Privacy Control', () => {
    expect(globalPrivacyControl()).toBe(false)
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true })
    expect(globalPrivacyControl()).toBe(true)
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: undefined, configurable: true })
  })
})

describe('<ConsentGate>', () => {
  const Analytics = () => <p>analytics mounted</p>

  it('renders nothing before a choice', () => {
    render(
      <ConsentGate>
        <Analytics />
      </ConsentGate>,
    )
    expect(screen.queryByText('analytics mounted')).toBeNull()
  })

  it('renders nothing after a no', () => {
    saveConsent(false)
    render(
      <ConsentGate>
        <Analytics />
      </ConsentGate>,
    )
    expect(screen.queryByText('analytics mounted')).toBeNull()
  })

  it('mounts analytics as soon as the visitor says yes, without a reload', () => {
    render(
      <ConsentGate>
        <Analytics />
      </ConsentGate>,
    )
    act(() => {
      saveConsent(true)
    })
    expect(screen.getByText('analytics mounted')).toBeTruthy()
    expect(reload).not.toHaveBeenCalled()
  })

  it('clears Amplitude storage and reloads when a yes is withdrawn', () => {
    saveConsent(true)
    render(
      <ConsentGate>
        <Analytics />
      </ConsentGate>,
    )
    expect(screen.getByText('analytics mounted')).toBeTruthy()
    document.cookie = 'AMP_bdf590ed8d=device-id; Path=/'
    window.localStorage.setItem('AMP_unsent_bdf590ed8d', '[]')
    act(() => {
      saveConsent(false)
    })
    expect(screen.queryByText('analytics mounted')).toBeNull()
    expect(document.cookie).not.toContain('AMP_')
    expect(window.localStorage.getItem('AMP_unsent_bdf590ed8d')).toBeNull()
    expect(document.cookie).toContain(CONSENT_COOKIE)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('clears identifiers left from before the choice existed, without reloading', () => {
    document.cookie = 'AMP_bdf590ed8d=old-device; Path=/'
    render(
      <ConsentGate>
        <Analytics />
      </ConsentGate>,
    )
    expect(document.cookie).not.toContain('AMP_')
    expect(reload).not.toHaveBeenCalled()
  })
})
