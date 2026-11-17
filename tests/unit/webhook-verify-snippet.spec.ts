/**
 * THE CONSOLE'S verify.js REFUSES A REPLAYED DELIVERY
 * ===================================================
 *
 * Production QA re-test, 2026-11-16, #101 (partly fixed): deliveries carry
 * X-Webhook-Timestamp and X-Webhook-Signature-V2, an HMAC over
 * "<timestamp>.<delivery id>.<raw body>", but the Webhooks page still taught
 * receivers to check X-Webhook-Signature, an HMAC of the body alone, which a
 * captured delivery passes forever.
 *
 * The snippet the page hands out is run here, as a receiver would run it,
 * against deliveries signed by the platform's own signer (lib/webhooks/index.ts).
 */

import { generateTimestampedSignature, generateWebhookSignature, WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS } from '@/lib/webhooks'
import { VERIFY_SNIPPET } from '@/components/integrations/webhooks-present'

type Verify = (rawBody: string | Buffer, headers: unknown, secret: string) => boolean

/** The snippet as a receiver's module: ESM import and export, run as CommonJS here. */
function loadSnippet(): Verify {
  const source = VERIFY_SNIPPET.replace("import crypto from 'node:crypto'", "const crypto = require('node:crypto')").replace(
    'export function isFromBackenly',
    'function isFromBackenly',
  )
  return new Function('require', `${source}\nreturn isFromBackenly`)(require) as Verify
}

const SECRET = 'whsec-' + 'test-'.repeat(6)
const BODY = JSON.stringify({ event: 'row.inserted', table: 'orders', record: { id: 'o1', total: 42 } })
const DELIVERY = 'log-6f1c2b'
const NOW = 1_794_900_000_000

/** The headers deliverSingleAttempt sends, signed at `sentAt` (ms). */
function delivery(sentAt = NOW, body = BODY, id = DELIVERY): Record<string, string> {
  const timestamp = Math.floor(sentAt / 1000)
  return {
    'x-webhook-timestamp': String(timestamp),
    'x-webhook-delivery': id,
    'x-webhook-signature-v2': generateTimestampedSignature(timestamp, id, body, SECRET),
    'x-webhook-signature': generateWebhookSignature(body, SECRET),
  }
}

let isFromBackenly: Verify

beforeAll(() => {
  isFromBackenly = loadSnippet()
})

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW)
})

afterEach(() => {
  jest.restoreAllMocks()
})

it('accepts a delivery as it arrives, from Node headers, a Headers object and raw bytes', () => {
  const headers = delivery()
  expect(isFromBackenly(BODY, headers, SECRET)).toBe(true)
  expect(isFromBackenly(BODY, new Headers(headers), SECRET)).toBe(true)
  expect(isFromBackenly(Buffer.from(BODY), headers, SECRET)).toBe(true)
})

it('refuses the same delivery sent again after the tolerance, and one stamped in the future', () => {
  const captured = delivery()
  jest.spyOn(Date, 'now').mockReturnValue(NOW + (WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS + 1) * 1000)
  expect(isFromBackenly(BODY, captured, SECRET)).toBe(false)
  jest.spyOn(Date, 'now').mockReturnValue(NOW - (WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS + 1) * 1000)
  expect(isFromBackenly(BODY, captured, SECRET)).toBe(false)
  // Within the tolerance it is still the same delivery.
  jest.spyOn(Date, 'now').mockReturnValue(NOW + (WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS - 1) * 1000)
  expect(isFromBackenly(BODY, captured, SECRET)).toBe(true)
})

it('refuses a changed body, delivery id or timestamp, and another secret', () => {
  const headers = delivery()
  expect(isFromBackenly(BODY.replace('42', '4200'), headers, SECRET)).toBe(false)
  expect(isFromBackenly(BODY, { ...headers, 'x-webhook-delivery': 'log-other' }, SECRET)).toBe(false)
  expect(isFromBackenly(BODY, { ...headers, 'x-webhook-timestamp': String(Number(headers['x-webhook-timestamp']) + 1) }, SECRET)).toBe(false)
  expect(isFromBackenly(BODY, headers, SECRET + 'x')).toBe(false)
})

it('refuses a request that carries only the body-only signature, or no headers', () => {
  const { 'x-webhook-signature': bodyOnly } = delivery()
  expect(isFromBackenly(BODY, { 'x-webhook-signature': bodyOnly }, SECRET)).toBe(false)
  expect(isFromBackenly(BODY, {}, SECRET)).toBe(false)
  expect(isFromBackenly(BODY, { ...delivery(), 'x-webhook-timestamp': 'not-a-time' }, SECRET)).toBe(false)
})
