/**
 * The values that cross between the app and a function's runner process.
 *
 * A run used to be in-process (route modules) or a worker thread (sandbox
 * bodies, structured clone), so a function's answer reached its caller as the
 * value it built: a BigInt from count(*), a Date, a Buffer. Over a pipe it is
 * JSON, which keeps none of those, so both sides tag what JSON cannot carry.
 * The two copies of that codec (isolation/client.ts in the app,
 * isolation/function-runner.cjs in the runner) must agree in both directions,
 * and what the runner sends is untrusted: decoding it must never run code or
 * reach a prototype.
 */

import { decodeValue, encodeValue } from '@/lib/services/ai-functions/isolation/client'

const runner = require('../../lib/services/ai-functions/isolation/function-runner.cjs') as {
  encode: (v: unknown) => unknown
  decode: (v: unknown) => unknown
}

/** App to runner, as the pipe carries it. */
const toRunner = (value: unknown) => runner.decode(JSON.parse(JSON.stringify(encodeValue(value))))
/** Runner to app, as the pipe carries it. */
const toApp = (value: unknown) => decodeValue(JSON.parse(JSON.stringify(runner.encode(value))))

const SAMPLES: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['a string', 'café ✓'],
  ['a number', 42.5],
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['a BigInt beyond 2^53', BigInt('123456789012345678901234567890')],
  ['a negative BigInt', BigInt(-5)],
  ['a Date', new Date('2026-11-14T08:30:00.123Z')],
  ['bytes', Buffer.from([0, 1, 2, 250, 255])],
  ['a Map', new Map<unknown, unknown>([['a', 1], [2, new Date(0)]])],
  ['a Set', new Set([1, 'two', BigInt(3)])],
  ['nested', { rows: [{ id: BigInt(7), at: new Date(1000), note: undefined }], total: 1, list: [undefined, null, NaN] }],
  ['an object using the tag as a key', { $bkn: 'u', v: 'not a tag' }],
]

describe('the wire between the app and a runner', () => {
  it.each(SAMPLES)('carries %s from the app to the runner unchanged', (_what, value) => {
    expect(toRunner(value)).toEqual(value)
  })

  it.each(SAMPLES)('carries %s from the runner to the app unchanged', (_what, value) => {
    expect(toApp(value)).toEqual(value)
  })

  it('keeps an invalid date invalid', () => {
    expect(Number.isNaN((toApp(new Date(NaN)) as Date).getTime())).toBe(true)
    expect(Number.isNaN((toRunner(new Date(NaN)) as Date).getTime())).toBe(true)
  })

  it('sends what JSON sends for functions and toJSON, and refuses a cycle as JSON does', () => {
    expect(toApp({ keep: 1, fn: () => 1, url: new URL('https://example.test/a') })).toEqual({ keep: 1, url: 'https://example.test/a' })
    const cycle: Record<string, unknown> = { a: 1 }
    cycle.self = cycle
    expect(() => runner.encode(cycle)).toThrow(/circular/i)
    expect(() => encodeValue(cycle)).toThrow(/circular/i)
  })

  it('never lets a value from a run set a prototype', () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "nested": {"__proto__": {"polluted": true}}}')
    const decoded = decodeValue(hostile) as Record<string, any>
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(decoded.nested)).toBe(Object.prototype)
    expect(({} as any).polluted).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(decoded, '__proto__')).toBe(true)
    const inRunner = runner.decode(hostile) as Record<string, any>
    expect(Object.getPrototypeOf(inRunner)).toBe(Object.prototype)
  })

  it('refuses a malformed BigInt rather than guessing', () => {
    expect(() => decodeValue({ $bkn: 'n', v: '12abc' })).toThrow(/BigInt/)
    expect(() => runner.decode({ $bkn: 'n', v: '1e9' })).toThrow(/BigInt/)
  })
})
