'use client'

import { useState, useEffect, Suspense } from 'react'
import Link from 'next/link'
import { Icon } from '@iconify/react'
import { useRouter, useSearchParams } from 'next/navigation'
import { login } from '@/lib/api/auth'
import { GlobalLoading } from '@/components/ui/GlobalLoading'
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

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showEmailForm, setShowEmailForm] = useState(false)
  const [oauthProviders, setOauthProviders] = useState<{ google: boolean; github: boolean } | null>(null)

  // Get redirect URL — sanitize to prevent loops back to /auth/*
  const rawRedirect = searchParams.get('redirect') || '/app'
  const isAuthPath = rawRedirect.startsWith('/auth') || rawRedirect === '/login' || rawRedirect === '/signup'
  const redirectUrl = isAuthPath ? '/app' : rawRedirect
  const errorParam = searchParams.get('error')

  useEffect(() => {
    if (errorParam === 'invalid_session') {
      setErrors({ password: 'Your session has expired. Please log in again.' })
      setIsSubmitting(false)
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
    setErrors({})
    setIsSubmitting(true)
    try {
      await login({ email, password })
      setTimeout(() => {
        window.location.href = redirectUrl
      }, 200)
    } catch (error) {
      setErrors({ password: error instanceof Error ? error.message : 'Login failed' })
      setIsSubmitting(false)
    }
  }

  return (
    <AuthChrome>
      <AuthCard
        eyebrow="Welcome back"
        title="Sign in to Backenly"
        subtitle="Pick up exactly where you left off."
      >
        {!showEmailForm ? (
          <>
            {(oauthProviders?.google || oauthProviders?.github) && (
              <div className="flex flex-col gap-3">
                {oauthProviders?.google && (
                  <OAuthButton
                    onClick={() =>
                      (window.location.href = `/api/auth/platform-google?redirect=${encodeURIComponent(redirectUrl)}`)
                    }
                    variant="light"
                  >
                    <GoogleSvg />
                    Continue with Google
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
                    Continue with GitHub
                  </OAuthButton>
                )}
              </div>
            )}

            <Divider label="or sign in with email" />

            <EmailOptionButton onClick={() => setShowEmailForm(true)} icon="solar:bolt-circle-linear">
              Continue with Email
            </EmailOptionButton>
          </>
        ) : (
          <>
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

              <div className="flex items-center justify-between -mb-2">
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Link
                  href="/auth/forgot-password"
                  className="text-[11px] text-violet-300 hover:text-violet-200 transition-colors"
                >
                  Forgot password?
                </Link>
              </div>
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
                    className="text-zinc-500 hover:text-zinc-300 transition-colors"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    <Icon icon={showPassword ? 'ri:eye-off-line' : 'ri:eye-line'} width={16} />
                  </button>
                }
              />

              <PrimaryButton type="submit" disabled={isSubmitting} loading={isSubmitting}>
                {isSubmitting ? 'Signing in…' : 'Sign in'}
              </PrimaryButton>
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
              Back to all sign-in options
            </button>
          </>
        )}

        <div className="mt-7 pt-6 border-t border-white/[0.06] text-center">
          <p className="text-xs text-zinc-400">
            New to Backenly?{' '}
            <Link
              href={redirectUrl !== '/app' ? `/auth/signup?redirect=${encodeURIComponent(redirectUrl)}` : '/auth/signup'}
              className="text-violet-300 hover:text-violet-200 transition-colors font-medium inline-flex items-center gap-1"
            >
              Create an account
              <Icon icon="solar:arrow-right-up-linear" width={11} />
            </Link>
          </p>
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
