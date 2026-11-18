/**
 * @jest-environment jsdom
 */
/**
 * The sign-in and sign-up pages send a person on to ?redirect= afterwards: an
 * invitation link, a page that asked them to sign in. Only a path on this site
 * may be followed. Anything else (another site, a protocol-relative address, a
 * script URL, a path a browser reads as another site once it drops tabs and
 * newlines) goes to /app instead.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'

const router = { push: jest.fn(), replace: jest.fn(), prefetch: jest.fn(), back: jest.fn(), refresh: jest.fn() }
let query = new URLSearchParams()
let signedIn = false

jest.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => query,
  usePathname: () => '/auth/login',
}))
jest.mock('@/lib/hooks/useUserSession', () => ({
  useUserSession: () => ({ isLoggedIn: signedIn, user: null, isLoading: false }),
}))
jest.mock('@/lib/api/auth', () => {
  const actual = jest.requireActual('@/lib/api/auth')
  return { ...actual, login: jest.fn(async () => ({ success: true })) }
})

const LoginPage = require('@/app/auth/login/page').default
const SignupPage = require('@/app/auth/signup/page').default

const ELSEWHERE = [
  'javascript:alert(document.domain)',
  'JavaScript:alert(1)',
  'data:text/html,<p>hi</p>',
  'https://elsewhere.example/x',
  '//elsewhere.example/x',
  '/\\elsewhere.example/x',
  '/\t/elsewhere.example/x',
  '/\n/elsewhere.example/x',
  ' javascript:alert(1)',
]

async function settle() {
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
}

beforeEach(() => {
  router.push.mockClear()
  router.replace.mockClear()
  global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response)) as unknown as typeof fetch
})

describe('a person who is already signed in', () => {
  beforeEach(() => { signedIn = true })

  it.each(ELSEWHERE)('sign-in sends %j to /app', async (target) => {
    query = new URLSearchParams({ redirect: target })
    render(<LoginPage />)
    await settle()
    expect(router.replace).toHaveBeenCalledWith('/app')
    expect(router.replace).not.toHaveBeenCalledWith(target)
  })

  it.each(ELSEWHERE)('sign-up sends %j to /app', async (target) => {
    query = new URLSearchParams({ redirect: target })
    render(<SignupPage />)
    await settle()
    expect(router.replace).toHaveBeenCalledWith('/app')
    expect(router.replace).not.toHaveBeenCalledWith(target)
  })

  it('a path on this site is followed, with its query and fragment', async () => {
    query = new URLSearchParams({ redirect: '/app/projects/p1/storage?bucket=photos#top' })
    render(<LoginPage />)
    await settle()
    expect(router.replace).toHaveBeenCalledWith('/app/projects/p1/storage?bucket=photos#top')
  })
})

describe('signing in with a password', () => {
  const realLocation = window.location
  let assigned: string[]

  beforeEach(() => {
    signedIn = false
    assigned = []
    // jsdom cannot navigate; record where the page sends the browser instead.
    delete (window as any).location
    ;(window as any).location = {
      ...realLocation,
      set href(value: string) { assigned.push(value) },
      get href() { return 'https://backenly.test/auth/login' },
    }
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
    ;(window as any).location = realLocation
  })

  it.each(['javascript:alert(document.domain)', 'https://elsewhere.example/x', '/\t/elsewhere.example/x'])(
    'then goes to /app, not %j',
    async (target) => {
      query = new URLSearchParams({ redirect: target })
      render(<LoginPage />)
      await settle()
      fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'ada.lovelace@gmail.com' } })
      fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'a-long-enough-Passw0rd!' } })
      await act(async () => { fireEvent.submit(screen.getByLabelText(/email/i).closest('form')!) })
      await act(async () => { jest.advanceTimersByTime(500) })
      expect(assigned).toEqual(['/app'])
    },
  )
})
