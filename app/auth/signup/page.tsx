'use client'

import { useState, useEffect, Suspense } from 'react'
import Link from 'next/link'
import { Icon } from '@iconify/react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  checkSignupEmailEligibility,
  SIGNUP_EMAIL_REJECTION_MESSAGE,
} from '@/lib/auth/signup-email-eligibility'
import { AuthRequestError, getRegistrationRequirements, register } from '@/lib/api/auth'
import { PASSWORD_MIN_LENGTH, PASSWORD_POLICY_HINT, validatePasswordStrength } from '@/lib/auth/password-policy'
import { useUserSession } from '@/lib/hooks/useUserSession'
import { registerSiteIcons } from '@/lib/icons/registry'
import {
  AuthChrome,
  AuthCard,
  AuthFooterNote,
  OAuthButton,
  EmailOptionButton,
  Divider,
  FieldLabel,
  FieldInput,
  PrimaryButton,
  GoogleSvg,
} from '@/components/site/AuthShell'
import { TurnstileWidget, isTurnstileEnabled, resetTurnstile } from '@/components/site/TurnstileWidget'

registerSiteIcons()

// useSearchParams() forces a client-side-render bailout, so the reader must sit
// inside a Suspense boundary or `next build` fails prerendering this route.
export default function SignupPage() {
  return (
    <Suspense
      fallback={
        <AuthChrome>
          <AuthCard eyebrow="Get started" title="Create your Backenly account" subtitle="A live backend in under a minute.">
            <div className="h-24" />
          </AuthCard>
        </AuthChrome>
      }
    >
      <SignupForm />
    </Suspense>
  )
}

function SignupForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [errors, setErrors] = useState<{ email?: string; password?: string; setupToken?: string }>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  // The installer prints a claim link carrying the token. Read once, at first
  // render, so the form opens already filled in.
  const [claimLinkToken] = useState(() => searchParams.get('setup_token')?.trim() || '')
  const [showEmailForm, setShowEmailForm] = useState(!!claimLinkToken)
  const [oauthProviders, setOauthProviders] = useState<{ google: boolean; github: boolean } | null>(null)
  const [refCode, setRefCode] = useState<string | null>(null)
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  // A self-hosted deployment is claimed by the first account that presents the
  // token `npm run selfhost` printed. The register route refuses a first signup
  // without it, so the form has to be able to send it.
  const [setupTokenRequired, setSetupTokenRequired] = useState(!!claimLinkToken)
  const [setupToken, setSetupToken] = useState(claimLinkToken)

  // Honor ?redirect= (e.g. an org-invite accept page) — sanitized the same way
  // as login so we never loop back into /auth/*.
  const rawRedirect = searchParams.get('redirect') || '/app'
  const isAuthPath = rawRedirect.startsWith('/auth') || rawRedirect === '/login' || rawRedirect === '/signup'
  const redirectUrl = isAuthPath ? '/app' : rawRedirect
  const { isLoggedIn } = useUserSession()

  useEffect(() => {
    if (isLoggedIn) {
      router.replace(redirectUrl)
    }
  }, [isLoggedIn, redirectUrl, router])

  useEffect(() => {
    fetch('/api/auth/platform-providers')
      .then((res) => res.json())
      .then((data) => setOauthProviders(data))
      .catch(() => setOauthProviders({ google: false, github: false }))
  }, [])

  useEffect(() => {
    getRegistrationRequirements()
      .then((r) => { if (r.setupTokenRequired) setSetupTokenRequired(true) })
      // Unanswerable is not "not required": the first refusal reveals the field.
      .catch(() => {})
  }, [])

  // Then drop the claim link's token from the address bar, so it does not sit
  // in history or on a shared screen.
  useEffect(() => {
    if (!searchParams.get('setup_token')) return
    const rest = new URLSearchParams(searchParams.toString())
    rest.delete('setup_token')
    const query = rest.toString()
    router.replace(query ? `/auth/signup?${query}` : '/auth/signup', { scroll: false })
  }, [searchParams, router])

  // Capture ?ref= once: remember it for the email form AND drop a cookie so it
  // survives the OAuth round-trip (the register route + OAuth callbacks read it).
  useEffect(() => {
    const ref = searchParams.get('ref')
    if (ref && /^[A-Za-z0-9]{5,12}$/.test(ref)) {
      const code = ref.toUpperCase()
      setRefCode(code)
      document.cookie = `backenly_ref=${code}; path=/; max-age=2592000; samesite=lax`
    }
  }, [searchParams])

  const validateEmail = (val: string) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!val) return 'Email is required'
    if (!emailRegex.test(val)) return 'Please enter a valid email address'
    const eligibility = checkSignupEmailEligibility(val)
    if (!eligibility.ok) return eligibility.reason || SIGNUP_EMAIL_REJECTION_MESSAGE
    return null
  }

  const validatePassword = (val: string) => {
    if (!val) return 'Password is required'
    const strength = validatePasswordStrength(val)
    return strength.valid ? null : strength.message || 'Choose a stronger password'
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const emailError = validateEmail(email)
    const passwordError = validatePassword(password)
    const setupTokenError =
      setupTokenRequired && !setupToken.trim()
        ? 'Paste the setup token printed by npm run selfhost.'
        : null
    if (emailError || passwordError || setupTokenError) {
      setErrors({
        email: emailError || undefined,
        password: passwordError || undefined,
        setupToken: setupTokenError || undefined,
      })
      return
    }
    // Turnstile issues single-use tokens, so a failed submit must not be
    // retried with the same one — the server would reject it as a duplicate.
    if (isTurnstileEnabled && !turnstileToken) {
      setErrors({ email: 'Please complete the verification check below.' })
      return
    }
    setErrors({})
    setIsSubmitting(true)
    try {
      await register({
        email,
        password,
        ...(refCode ? { ref: refCode } : {}),
        ...(turnstileToken ? { turnstileToken } : {}),
        ...(setupTokenRequired && setupToken.trim() ? { setupToken: setupToken.trim() } : {}),
      })
      router.push(redirectUrl)
    } catch (error) {
      if (error instanceof AuthRequestError && error.code === 'SETUP_TOKEN_REJECTED') {
        // Also the fallback when the requirements could not be read up front.
        setSetupTokenRequired(true)
        setErrors({ setupToken: error.message })
      } else {
        setErrors({ password: error instanceof Error ? error.message : 'Registration failed' })
      }
      setIsSubmitting(false)
      setTurnstileToken(null)
      resetTurnstile()
    }
  }

  if (isLoggedIn) {
    return (
      <AuthChrome>
        <AuthCard
          eyebrow="Account"
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
        eyebrow="Get started"
        title="Create your Backenly account"
        subtitle="A live backend in under a minute."
      >
        {refCode && (
          <div className="mb-5 flex items-center gap-2 rounded-lg border border-white/[0.14] bg-white/[0.05] px-3 py-2.5 text-[12px] text-violet-100">
            <Icon icon="solar:gift-linear" width={16} className="text-violet-300 shrink-0" />
            <span>You were invited — <span className="font-medium text-white">+200 bonus credits</span> land on your first sign-in.</span>
          </div>
        )}
        {!showEmailForm ? (
          <>
            {(oauthProviders?.google || oauthProviders?.github) && (
              <div className="flex flex-col gap-3">
                {oauthProviders?.google && (
                  <OAuthButton
                    onClick={() => (window.location.href = `/api/auth/platform-google?redirect=${encodeURIComponent(redirectUrl)}`)}
                    variant="light"
                  >
                    <GoogleSvg />
                    Sign up with Google
                  </OAuthButton>
                )}
                {oauthProviders?.github && (
                  <OAuthButton
                    onClick={() => (window.location.href = `/api/auth/platform-github?redirect=${encodeURIComponent(redirectUrl)}`)}
                    variant="dark"
                  >
                    <Icon icon="ri:github-fill" width={18} className="text-zinc-100" />
                    Sign up with GitHub
                  </OAuthButton>
                )}
              </div>
            )}

            <Divider label="or sign up with email" />

            <EmailOptionButton onClick={() => setShowEmailForm(true)}>
              Continue with Email
            </EmailOptionButton>
          </>
        ) : (
          <>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4 mb-5">
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

              <FieldLabel htmlFor="password">Password</FieldLabel>
              <FieldInput
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={`At least ${PASSWORD_MIN_LENGTH} characters`}
                disabled={isSubmitting}
                error={errors.password}
                helper={errors.password ? undefined : PASSWORD_POLICY_HINT}
                trailing={
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    className="text-zinc-500 hover:text-zinc-300 transition-colors"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    <Icon icon={showPassword ? 'ri:eye-off-line' : 'ri:eye-line'} width={16} />
                  </button>
                }
              />

              {setupTokenRequired && (
                <>
                  <FieldLabel htmlFor="setupToken">Setup token</FieldLabel>
                  <FieldInput
                    id="setupToken"
                    type="text"
                    value={setupToken}
                    onChange={(e) => setSetupToken(e.target.value)}
                    placeholder="Printed by npm run selfhost"
                    disabled={isSubmitting}
                    error={errors.setupToken}
                    helper={
                      errors.setupToken
                        ? undefined
                        : 'Claims this self-hosted deployment. Also in .env as BACKENLY_SETUP_TOKEN.'
                    }
                  />
                </>
              )}

              <TurnstileWidget onToken={setTurnstileToken} className="mt-1" />

              <PrimaryButton type="submit" disabled={isSubmitting} loading={isSubmitting}>
                {isSubmitting ? 'Creating account…' : 'Create account'}
              </PrimaryButton>

              <p className="text-[11px] text-zinc-500 text-center mt-1 font-light">
                By creating an account, you agree to our{' '}
                <Link href="/terms" className="text-zinc-300 hover:text-white">
                  Terms
                </Link>{' '}
                and{' '}
                <Link href="/privacy" className="text-zinc-300 hover:text-white">
                  Privacy Policy
                </Link>
                .
              </p>
            </form>

            <button
              type="button"
              onClick={() => {
                setShowEmailForm(false)
                setErrors({})
                setEmail('')
                setPassword('')
              }}
              className="w-full text-center text-xs text-zinc-400 hover:text-zinc-200 transition-colors inline-flex items-center justify-center gap-1.5 group"
            >
              <Icon
                icon="solar:alt-arrow-down-linear"
                width={11}
                className="rotate-90 group-hover:-translate-x-0.5 transition-transform"
              />
              Back to all sign-up options
            </button>
          </>
        )}

        <div className="mt-7 pt-6 border-t border-white/[0.06] text-center">
          <p className="text-xs text-zinc-400">
            Already have an account?{' '}
            <Link
              href={redirectUrl !== '/app' ? `/auth/login?redirect=${encodeURIComponent(redirectUrl)}` : '/auth/login'}
              className="text-violet-300 hover:text-violet-200 transition-colors font-medium inline-flex items-center gap-1"
            >
              Sign in
              <Icon icon="solar:arrow-right-up-linear" width={11} />
            </Link>
          </p>
        </div>
      </AuthCard>

      <AuthFooterNote />
    </AuthChrome>
  )
}
