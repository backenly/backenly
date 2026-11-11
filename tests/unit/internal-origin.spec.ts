/**
 * Which origins are the platform itself, for Connection Health.
 *
 * Production QA (2026-11-09) ran its store at localhost:5173 against a Cloud
 * project, and every one of its requests was set aside as "the platform"
 * (localhost was on the list), so the console said "Frontend: Not connected".
 * The platform is Backenly's own domains and the origin its console is served
 * on, port included; a developer's app on localhost is a frontend.
 */
import { INTERNAL_DOMAINS, isInternalOrigin } from '@/lib/security/internal-origin'

const original = process.env.NEXT_PUBLIC_APP_URL
afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = original
})

it("treats Backenly's own domains as the platform", () => {
  delete process.env.NEXT_PUBLIC_APP_URL
  for (const origin of ['https://backenly.com', 'https://www.backenly.com', 'https://docs.backenly.com/x']) {
    expect(isInternalOrigin(origin)).toBe(true)
  }
  expect(isInternalOrigin('https://backenly.com.evil.example')).toBe(false)
  expect(isInternalOrigin('https://notbackenly.com')).toBe(false)
})

it("treats a developer's app on localhost as a frontend on Cloud", () => {
  process.env.NEXT_PUBLIC_APP_URL = 'https://backenly.com'
  expect(isInternalOrigin('http://localhost:5173')).toBe(false)
  expect(isInternalOrigin('http://127.0.0.1:5173')).toBe(false)
})

it('treats the console as the platform where it is served on localhost, on its own port only', () => {
  process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000'
  expect(isInternalOrigin('http://localhost:3000')).toBe(true)
  expect(isInternalOrigin('http://localhost:3000/app/projects/p1')).toBe(true)
  expect(isInternalOrigin('http://localhost:5173')).toBe(false)
})

it('says nothing about what is not an origin', () => {
  expect(isInternalOrigin(null)).toBe(false)
  expect(isInternalOrigin('')).toBe(false)
  expect(isInternalOrigin('not a url')).toBe(false)
})

it('keeps the domains the "external users" milestone reads, localhost included', () => {
  expect(INTERNAL_DOMAINS).toEqual(['backenly.com', 'www.backenly.com', 'localhost', '127.0.0.1'])
})
