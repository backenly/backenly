'use client'

import { useState, useEffect, Suspense } from 'react'
import Link from 'next/link'
import { Icon } from '@iconify/react'
import { useRouter, useSearchParams } from 'next/navigation'
import { login, LoginError } from '@/lib/api/auth'
import { useUserSession } from '@/lib/hooks/useUserSession'
import { returnPathFrom } from '@/lib/auth/return-path'
import { GlobalLoading } from '@/components/ui/GlobalLoading'
import { registerSiteIcons } from '@/lib/icons/registry'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import {
  AuthChrome,
  AuthCard,
  AuthFooterNote,
  OAuthButton,
  Divider,
  FieldLabel,
  FieldInput,
  PrimaryButton,
  GoogleSvg,
} from '@/components/site/AuthShell'

registerSiteIcons()

/**
 * What the OAuth callbacks' `?error=` codes mean, in words.
 *
 * `email_not_verified` is the one people will actually meet: signing in with a
 * provider is treated as proof of the address, so an address the provider has
 * not verified cannot be accepted, and saying nothing would leave them
 * clicking the same button again.
 */
const OAUTH_ERRORS: Record<string, string> = {
  invalid_session: 'Your session has expired. Please log in again.',
  email_not_verified:
    'That account has no verified email address with the provider. Verify your email there and try again, or sign in with a password.',
  no_email: 'That provider did not share an email address, so there is nothing to sign you in as.',
  claim_requires_setup_token:
    'This deployment has not been claimed yet. Its operator claims it on the sign-up page with the setup token that npm run selfhost printed; Google and GitHub sign-in work after that.',
  blocked: 'This account cannot sign in. Contact support if you think that is wrong.',
  second_factor_required:
    'This account has two-factor authentication turned on. Sign in with your email, password and authenticator code instead of Google or GitHub.',
  signup_not_allowed: 'New accounts are not being accepted right now.',
  token_failed: 'Sign-in with that provider did not complete. Please try again.',
  userinfo_failed: 'Sign-in with that provider did not complete. Please try again.',
  oauth_failed: 'Sign-in with that provider did not complete. Please try again.',
}

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [errors, setErrors] = useState<{ email?: string; password?: string; totpCode?: string }>({})
  // Shown once the server asks for it: an account with two-factor
  // authentication signs in with its password and its authenticator's code.
  const [needsCode, setNeedsCode] = useState(false)
  const [totpCode, setTotpCode] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [oauthProviders, setOauthProviders] = useState<{ google: boolean; github: boolean } | null>(null)

  // The OAuth callbacks redirect here with ?error=... on every refusal. Only
  // invalid_session was ever explained, so the rest bounced people back to a
  // login form that looked like nothing had happened.
  // A path on this site only (lib/auth/return-path.ts); anything else, /app.
  const redirectUrl = returnPathFrom(searchParams.get('redirect'))
  const errorParam = searchParams.get('error')
  const { isLoggedIn } = useUserSession({ confirmSignedIn: true })

  useEffect(() => {
    if (isLoggedIn && !errorParam) {
      router.replace(redirectUrl)
    }
  }, [isLoggedIn, errorParam, redirectUrl, router])

  useEffect(() => {
    const message = errorParam ? OAUTH_ERRORS[errorParam] : null
    if (message) {
      setErrors({ password: message })
      setIsSubmitting(false)
      // The email form is always on screen, so this message (second_factor_required among them) shows under the password field.
    }
  }, [errorParam])

  useEffect(() => {
    fetch('/api/auth/platform-providers')
      .then((res) => res.json())
      .then((data) => setOauthProviders(data))
      .catch(() => setOauthProviders({ google: false, github: false }))
  }, [])

  const validateEmail = (val: string) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!val) return 'Email is required'
    if (!emailRegex.test(val)) return 'Please enter a valid email address'
    return null
  }

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    const emailError = validateEmail(email)
    if (!password) {
      setErrors({ email: emailError || undefined, password: 'Password is required' })
      return
    }
    if (emailError) {
      setErrors({ email: emailError, password: undefined })
      return
    }
    if (needsCode && !totpCode.trim()) {
      setErrors({ totpCode: 'Enter the code from your authenticator app, or a backup code' })
      return
    }
    setErrors({})
    setIsSubmitting(true)
    try {
      await login({ email, password, ...(needsCode ? { totpCode: totpCode.trim() } : {}) })
      setTimeout(() => {
        window.location.href = redirectUrl
      }, 200)
    } catch (error) {
      const code = error instanceof LoginError ? error.code : null
      if (code === 'TOTP_REQUIRED') {
        setNeedsCode(true)
        setErrors({})
      } else if (code === 'TOTP_INVALID') {
        setErrors({ totpCode: 'That code is not valid. Check your authenticator app and try again.' })
      } else {
        setErrors({ password: error instanceof Error ? error.message : 'Login failed' })
      }
      setIsSubmitting(false)
    }
  }

  if (isLoggedIn && !errorParam) {
    return (
      <AuthChrome>
        <AuthCard
          title="Already signed in"
          subtitle="Redirecting to your projects..."
        >
          <div className="flex h-24 items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white" />
          </div>
        </AuthCard>
      </AuthChrome>
    )
  }

  return (
    <AuthChrome>
      <AuthCard
        title="Sign in to Backenly"
        subtitle="Your projects are where you left them."
      >
        {/* The form is on screen straight away (site-wide pass, 2026-11-15); a provider's button sits above it only when that provider is configured. */}
        {(oauthProviders?.google || oauthProviders?.github) && (
          <>
              <div className={`grid gap-3 ${oauthProviders?.google && oauthProviders?.github ? 'grid-cols-2' : 'grid-cols-1'}`}>
                {oauthProviders?.google && (
                  <OAuthButton
                    onClick={() =>
                      (window.location.href = `/api/auth/platform-google?redirect=${encodeURIComponent(redirectUrl)}`)
                    }
                    variant="light"
                  >
                    <GoogleSvg />
                    <span className="sr-only">Continue with </span>Google
                  </OAuthButton>
                )}
                {oauthProviders?.github && (
                  <OAuthButton
                    onClick={() =>
                      (window.location.href = `/api/auth/platform-github?redirect=${encodeURIComponent(redirectUrl)}`)
                    }
                    variant="dark"
                  >
                    <Icon icon="ri:github-fill" width={18} className="text-zinc-100" />
                    <span className="sr-only">Continue with </span>GitHub
                  </OAuthButton>
                )}
              </div>
            <Divider label="or" />
          </>
        )}

            <form onSubmit={handleEmailLogin} className="flex flex-col gap-4 mb-5">
              <FieldLabel htmlFor="email">Email address</FieldLabel>
              <FieldInput
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                disabled={isSubmitting}
                error={errors.email}
              />

              <div className="relative flex flex-col gap-2">
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <FieldInput
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  disabled={isSubmitting}
                  error={errors.password}
                  trailing={
                    <button
                      type="button"
                      onClick={() => setShowPassword((s) => !s)}
                      className="rounded-sm text-zinc-500 hover:text-zinc-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      <Icon icon={showPassword ? 'ri:eye-off-line' : 'ri:eye-line'} width={16} />
                    </button>
                  }
                />
                <Link
                  href="/auth/forgot-password"
                  className="absolute right-0 top-0 rounded-[3px] text-[13px] text-zinc-300 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                >
                  Forgot password?
                </Link>
              </div>

              {needsCode && (
                <div className="flex flex-col gap-2">
                  <FieldLabel htmlFor="totp-code">Authenticator code</FieldLabel>
                  <FieldInput
                    id="totp-code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value)}
                    placeholder="6-digit code or a backup code"
                    disabled={isSubmitting}
                    error={errors.totpCode}
                  />
                </div>
              )}

              <PrimaryButton type="submit" disabled={isSubmitting} loading={isSubmitting}>
                {isSubmitting ? 'Signing in…' : needsCode ? 'Verify and sign in' : 'Sign in'}
              </PrimaryButton>
            </form>

        <div className="mt-[24px] border-t border-white/[0.08] pt-[20px] text-center">
          <p className="text-[14px] text-zinc-400">
            New to Backenly?{' '}
            <Link
              href={redirectUrl !== '/app' ? `/auth/signup?redirect=${encodeURIComponent(redirectUrl)}` : '/auth/signup'}
              className="rounded-[3px] font-medium text-white underline decoration-white/30 underline-offset-4 transition-colors hover:decoration-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              Create an account
            </Link>
          </p>
          {/* Backenly Cloud's enterprise customers sign in with an emailed code
              until they choose a password. The page says the same thing for
              every address, so linking it reveals nothing about who has one. */}
          {CLOUD_CONTROL_PLANE && (
            <p className="mt-[8px] text-[14px] text-zinc-400 [text-wrap:balance]">
              On Backenly Enterprise?{' '}
              <Link
                href="/auth/enterprise"
                className="rounded-[3px] font-medium text-white underline decoration-white/30 underline-offset-4 transition-colors hover:decoration-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              >
                Sign in with an emailed code
              </Link>
            </p>
          )}
        </div>
      </AuthCard>

      <AuthFooterNote />
    </AuthChrome>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={<GlobalLoading />}>
      <LoginForm />
    </Suspense>
  )
}
