/**
 * The import API answers only where the deployment turns it on: Backenly Cloud
 * with BACKENLY_IMPORT=enabled. Otherwise every /api/import route answers 404,
 * and the console, which offers importing only where GET /api/import answers
 * (components/onboarding/useOrgImports.ts), shows none of it.
 *
 * Database-free: the edition and the modules http.ts reaches are stubbed.
 */

let cloud = true
jest.mock('@/lib/edition/cloud-only', () => ({ isCloudEdition: () => cloud }))
jest.mock('@/lib/security/auth-rate-limit', () => ({ consume: jest.fn() }))
jest.mock('@/lib/security/rate-limit-decision', () => ({ rateLimitHeaders: jest.fn(() => ({})) }))
jest.mock('@/lib/import/driver', () => ({ ImportInputError: class extends Error {} }))
jest.mock('@/lib/import/jobs', () => ({ ImportRefusedError: class extends Error {} }))
jest.mock('@/lib/import/redact', () => ({ redactedMessage: (m: unknown) => String(m) }))

import { readFileSync } from 'fs'
import { join } from 'path'
import { cloudOnly, importEnabled } from '@/lib/import/http'

const saved = process.env.BACKENLY_IMPORT
afterEach(() => {
  cloud = true
  if (saved === undefined) delete process.env.BACKENLY_IMPORT
  else process.env.BACKENLY_IMPORT = saved
})

it('is off on Cloud until the deployment enables it', async () => {
  delete process.env.BACKENLY_IMPORT
  expect(importEnabled()).toBe(false)
  const res = cloudOnly()
  expect(res?.status).toBe(404)
  expect(await res?.json()).toMatchObject({ code: 'CLOUD_ONLY_FEATURE' })

  process.env.BACKENLY_IMPORT = 'true'
  expect(importEnabled()).toBe(false)
  expect(cloudOnly()?.status).toBe(404)
})

it('answers on Cloud with BACKENLY_IMPORT=enabled', () => {
  process.env.BACKENLY_IMPORT = 'enabled'
  expect(importEnabled()).toBe(true)
  expect(cloudOnly()).toBeNull()
})

it('never answers off Cloud, whatever the variable says', () => {
  cloud = false
  process.env.BACKENLY_IMPORT = 'enabled'
  expect(importEnabled()).toBe(false)
  expect(cloudOnly()?.status).toBe(404)
})

it.each([
  'app/api/import/route.ts',
  'app/api/import/inspect/route.ts',
  'app/api/import/[jobId]/route.ts',
  'app/api/import/[jobId]/cancel/route.ts',
])('%s asks cloudOnly() before anything else in every handler', (file) => {
  const source = readFileSync(join(process.cwd(), file), 'utf8')
  const handlers = [...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\([^)]*\)[^{]*\{\s*([^\n]*)/g)]
  expect(handlers.length).toBeGreaterThan(0)
  for (const [, method, firstLine] of handlers) {
    expect([method, firstLine.trim()]).toEqual([method, expect.stringMatching(/^return cloudOnly\(\) \?\? /)])
  }
})
