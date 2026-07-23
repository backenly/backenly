'use client'

import { useState, useEffect, Suspense } from 'react'
import Link from 'next/link'
import { Icon } from '@iconify/react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  checkSignupEmailEligibility,
  SIGNUP_EMAIL_REJECTION_MESSAGE,
} from '@/lib/auth/email-eligibility'
import { register } from '@/lib/api/auth'
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
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showEmailForm, setShowEmailForm] = useState(false)
  const [oauthProviders, setOauthProviders] = useState<{ google: boolean; github: boolean } | null>(null)
  const [refCode, setRefCode] = useState<string | null>(null)

  // Honor ?redirect= (e.g. an org-invite accept page) — sanitized the same way
  // as login so we never loop back into /auth/*.
  const rawRedirect = searchParams.get('redirect') || '/app'
  const isAuthPath = rawRedirect.startsWith('/auth') || rawRedirect === '/login' || rawRedirect === '/signup'
  const redirectUrl = isAuthPath ? '/app' : rawRedirect

  useEffect(() => {
    fetch('/api/auth/platform-providers')
      .then((res) => res.json())
      .then((data) => setOauthProviders(data))
      .catch(() => setOauthProviders({ google: false, github: false }))
  }, [])

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
    if (val.length < 8) return 'Password must be at least 8 characters'
    if (!/(?=.*[a-z])/.test(val)) return 'Password must contain at least one lowercase letter'
    if (!/(?=.*[A-Z])/.test(val)) return 'Password must contain at least one uppercase letter'
    if (!/(?=.*\d)/.test(val)) return 'Password must contain at least one number'
    return null
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const emailError = validateEmail(email)
    const passwordError = validatePassword(password)
    if (emailError || passwordError) {
      setErrors({ email: emailError || undefined, password: passwordError || undefined })
      return
    }
    setErrors({})
    setIsSubmitting(true)
    try {
      await register({ email, password, ...(refCode ? { ref: refCode } : {}) })
      router.push(redirectUrl)
    } catch (error) {
      setErrors({ password: error instanceof Error ? error.message : 'Registration failed' })
      setIsSubmitting(false)
    }
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
                placeholder="At least 8 characters"
                disabled={isSubmitting}
                error={errors.password}
                helper={errors.password ? undefined : '8+ chars, mix of upper, lower, and a number.'}
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
