/**
 * A development origin never closes a project's CORS allowlist.
 *
 * Found on backenly.com: a coding agent connected the dev server it was
 * working against (http://localhost:5173). Connected origins are the allowlist
 * on the SDK routes, so the app's deployed origin was refused from then on,
 * and the project only worked on localhost.
 */
import { allowsAnyOrigin, isDevelopmentOrigin } from '@/lib/security/development-origin'

describe('which origins are a developer’s own machine or network', () => {
  it('recognises loopback, .local and private-network addresses', () => {
    for (const origin of [
      'http://localhost:5173',
      'http://127.0.0.1:3000',
      'http://[::1]:8080',
      'http://app.localhost',
      'http://my-mac.local:3000',
      'http://192.168.1.11:5173',
      'http://10.0.0.4',
      'http://172.20.1.2:3000',
    ]) {
      expect([origin, isDevelopmentOrigin(origin)]).toEqual([origin, true])
    }
  })

  it('treats every other host as deployed', () => {
    for (const origin of [
      'https://myapp.vercel.app',
      'https://app.example.com',
      'https://localhost.example.com',
      // RFC 5737 documentation addresses: routable in shape, never a real host.
      'http://203.0.113.10',
      'https://198.51.100.7:8443',
      'not a url',
    ]) {
      expect([origin, isDevelopmentOrigin(origin)]).toEqual([origin, false])
    }
  })
})

describe('when connected origins close the allowlist', () => {
  it('stays open with nothing connected, or only development origins', () => {
    expect(allowsAnyOrigin([])).toBe(true)
    expect(allowsAnyOrigin(['http://localhost:5173', 'http://192.168.1.11:5173'])).toBe(true)
  })

  it('closes once a deployed origin is connected', () => {
    expect(allowsAnyOrigin(['http://localhost:5173', 'https://myapp.vercel.app'])).toBe(false)
    expect(allowsAnyOrigin(['https://myapp.vercel.app'])).toBe(false)
  })
})
