/**
 * @jest-environment jsdom
 */
/**
 * Submitting before the verification check is done says so under the check,
 * where the form's own errors appear. It used to sit under the email field,
 * outlining a valid address in red (production QA, 2026-11-09).
 */
import { act, fireEvent, render, screen } from '@testing-library/react'

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn(), back: jest.fn(), refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/auth/signup',
}))

// The check is on only with a site key, read when the widget's module loads.
process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'test-site-key'
const SignupPage = require('@/app/auth/signup/page').default

beforeEach(() => {
  global.fetch = jest.fn(() =>
    Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response),
  ) as unknown as typeof fetch
})

it('says under the check that it is not done, and leaves a valid email alone', async () => {
  render(<SignupPage />)
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
  fireEvent.click(screen.getByRole('button', { name: /Continue with Email/ }))
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'ada.lovelace@gmail.com' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-long-enough-Passw0rd!' } })
  await act(async () => { fireEvent.submit(screen.getByLabelText('Email address').closest('form')!) })

  expect(screen.getByText('Complete the verification check above to create your account.')).toBeInTheDocument()
  expect(screen.queryByText(/verification check below/)).toBeNull()
  expect(screen.getByLabelText('Email address')).not.toHaveAttribute('aria-invalid', 'true')
  // Nothing was sent: the page only read whether a setup token is needed.
  expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining('register'), expect.objectContaining({ method: 'POST' }))
})
