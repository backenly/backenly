/**
 * The PGRST303 diagnostic reports JWT timing on an authentication failure, so
 * these tests pin both halves of its contract: it records the numbers needed to
 * tell a clock disagreement from a token fault, and it can neither leak a
 * credential nor break the request it observes.
 */
import jwt from 'jsonwebtoken'
import {
  buildPgrstClockDiagnostic,
  classifySource,
  decodeTokenTiming,
  isPgrst303,
  logPgrstClockDiagnostic,
} from '@/lib/observability/pgrst-clock-diagnostic'

const SECRET = 'test-secret-not-a-real-key'

function tokenWith(iatOffsetS: number, ttlS = 60): string {
  const iat = Math.floor(Date.now() / 1000) + iatOffsetS
  return jwt.sign({ role: 'anon', project_id: 'p1', iat, exp: iat + ttlS }, SECRET, { algorithm: 'HS256' })
}

describe('PGRST303 clock diagnostic', () => {
  describe('captures the timing metadata', () => {
    it('reports a future iat as a positive delta', () => {
      const d = buildPgrstClockDiagnostic({
        requestId: 'req-1', table: 'widgets', timing: decodeTokenTiming(tokenWith(90)),
      })
      expect(d.iatMinusNowS).toBeGreaterThanOrEqual(89)
      expect(d.iatMinusNowS).toBeLessThanOrEqual(91)
      expect(d.tokenAgeS).toBeLessThan(0)
      expect(d).toMatchObject({ event: 'pgrst303_clock', requestId: 'req-1', table: 'widgets' })
    })

    it('reports a normally minted token as delta 0', () => {
      const d = buildPgrstClockDiagnostic({
        requestId: 'req-2', table: 'widgets', timing: decodeTokenTiming(tokenWith(0)),
      })
      expect(d.iatMinusNowS).toBe(0)
      expect(d.tokenAgeS).toBe(0)
      expect(d.decodeError).toBeUndefined()
    })

    it('records timing unavailable rather than a silently null iat', () => {
      const d = buildPgrstClockDiagnostic({ requestId: 'r', table: 't', timing: null })
      expect(d.iat).toBeNull()
      expect(d.decodeError).toBe('timing unavailable')
    })
  })

  describe('source describes the network path, not the caller', () => {
    it('classifies loopback as internal_loopback and never names a component', () => {
      for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
        expect(classifySource(addr)).toBe('internal_loopback')
      }
      expect(classifySource('203.0.113.9')).toBe('external')
      expect(classifySource(null)).toBe('external')

      // Loopback proves the transport path only. Asserting a specific internal
      // caller from it would be an unfounded attribution.
      const line = JSON.stringify(
        buildPgrstClockDiagnostic({
          requestId: 'r', table: 't', timing: decodeTokenTiming(tokenWith(0)), remoteAddress: '127.0.0.1',
        }),
      )
      expect(line).toContain('internal_loopback')
      expect(line.toLowerCase()).not.toContain('sweep')
      expect(line.toLowerCase()).not.toContain('scheduled')
      expect(line.toLowerCase()).not.toContain('cron')
    })
  })

  describe('never exposes a token or secret', () => {
    it('holds no JWT: the API accepts timing integers, not a token', () => {
      const token = tokenWith(90)
      const lines: string[] = []
      logPgrstClockDiagnostic({
        requestId: 'req-3', table: 'widgets', timing: decodeTokenTiming(token), logger: l => lines.push(l),
      })
      const line = lines[0]
      expect(line).not.toContain(token)
      expect(line).not.toContain(token.split('.')[1]) // payload segment
      expect(line).not.toContain(token.split('.')[2]) // signature
      expect(line).not.toContain(SECRET)
    })

    it('carries only the declared fields — no claims bag', () => {
      const d = buildPgrstClockDiagnostic({
        requestId: 'req-4', table: 'widgets', timing: decodeTokenTiming(tokenWith(5)),
      })
      expect(Object.keys(d).sort()).toEqual(
        ['event', 'exp', 'iat', 'iatMinusNowS', 'nowEpochS', 'requestId', 'source', 'table', 'tokenAgeS'].sort(),
      )
      expect(JSON.stringify(d)).not.toContain('anon')
      expect(JSON.stringify(d)).not.toContain('p1')
    })
  })

  describe('stays quiet on healthy traffic', () => {
    it('only recognises PGRST303', () => {
      expect(isPgrst303('PGRST303')).toBe(true)
      for (const other of ['PGRST301', 'PGRST205', 'PGRST106', null, undefined, '']) {
        expect(isPgrst303(other)).toBe(false)
      }
    })
  })

  describe('cannot throw', () => {
    it.each([
      ['empty', ''],
      ['not a jwt', 'garbage'],
      ['wrong segment count', 'a.b'],
      ['undecodable payload', 'a.!!!not-base64!!!.c'],
      ['valid base64, not json', `a.${Buffer.from('nope').toString('base64')}.c`],
    ])('decodeTokenTiming reports decodeError for %s', (_l, bad) => {
      const t = decodeTokenTiming(bad)
      expect(t.iat).toBeNull()
      expect(typeof t.decodeError).toBe('string')
    })

    it('swallows a logger that throws', () => {
      expect(() =>
        logPgrstClockDiagnostic({
          requestId: 'r', table: 't', timing: decodeTokenTiming(tokenWith(0)),
          logger: () => { throw new Error('log sink down') },
        }),
      ).not.toThrow()
    })

    it('handles a token with no iat claim', () => {
      const weird = jwt.sign({ role: 'anon' }, SECRET, { algorithm: 'HS256', noTimestamp: true })
      const t = decodeTokenTiming(weird)
      expect(t.iat).toBeNull()
      expect(t.decodeError).toBeUndefined()
    })
  })
})
