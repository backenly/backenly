'use client'

import { useState, Suspense } from 'react'
import Link from 'next/link'
import { Icon } from '@iconify/react'
import { registerSiteIcons } from '@/lib/icons/registry'
import { GlobalLoading } from '@/components/ui/GlobalLoading'
import {
  AuthChrome,
  AuthCard,
  AuthFooterNote,
  FieldLabel,
  FieldInput,
  PrimaryButton,
} from '@/components/site/AuthShell'

registerSiteIcons()

function ForgotPasswordForm() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const validateEmail = (val: string) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!val) return 'Email is required'
    if (!emailRegex.test(val)) return 'Please enter a valid email address'
    return null
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const emailErr = validateEmail(email)
    if (emailErr) {
      setError(emailErr)
      return
    }

    setError(null)
    setIsSubmitting(true)
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Failed to send reset link')
        return
      }

      setSubmitted(true)
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setIsSubmitting(false)
    }
  }

  if (submitted) {
    return (
      <AuthChrome>
        <AuthCard
          eyebrow="Check your email"
          title="Reset link sent"
          subtitle={`If an account exists for ${email}, a password reset link has been sent.`}
        >
          <div className="mb-6 flex items-start gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] p-4 text-xs text-emerald-200 leading-relaxed">
            <Icon icon="solar:check-circle-bold" width={20} className="text-emerald-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-emerald-300">Password reset link sent</p>
              <p className="mt-1 text-zinc-300">
                The link expires in 1 hour. If you don&apos;t see the email, check your spam folder or{' '}
                <button
                  type="button"
                  onClick={() => {
                    setSubmitted(false)
                    setError(null)
                  }}
                  className="text-violet-300 hover:text-violet-200 underline font-medium"
                >
                  try again
                </button>.
              </p>
            </div>
          </div>

          <Link
            href="/auth/login"
            className="group inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg border border-white/[0.12] bg-white/[0.03] px-5 text-[15px] font-semibold text-white transition hover:border-white/25 hover:bg-white/[0.06]"
          >
            <Icon
              icon="solar:alt-arrow-down-linear"
              width={14}
              className="rotate-90 group-hover:-translate-x-0.5 transition-transform text-zinc-400 group-hover:text-white"
            />
            Back to sign in
          </Link>

          <div className="mt-7 pt-6 border-t border-white/[0.06] text-center">
            <p className="text-xs text-zinc-400">
              Need help?{' '}
              <Link
                href="/contact"
                className="text-violet-300 hover:text-violet-200 transition-colors font-medium inline-flex items-center gap-1"
              >
                Contact support
                <Icon icon="solar:arrow-right-up-linear" width={11} />
              </Link>
            </p>
          </div>
        </AuthCard>

        <AuthFooterNote />
      </AuthChrome>
    )
  }

  return (
    <AuthChrome>
      <AuthCard
        eyebrow="Account recovery"
        title="Reset your password"
        subtitle="Enter your account's email and we'll send you a recovery link."
      >
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 mb-5">
          <FieldLabel htmlFor="email">Email address</FieldLabel>
          <FieldInput
            id="email"
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              if (error) setError(null)
            }}
            placeholder="you@example.com"
            disabled={isSubmitting}
            error={error || undefined}
          />

          <PrimaryButton type="submit" disabled={isSubmitting} loading={isSubmitting}>
            {isSubmitting ? 'Sending link…' : 'Send reset link'}
          </PrimaryButton>
        </form>

        <div className="mt-7 pt-6 border-t border-white/[0.06] text-center">
          <p className="text-xs text-zinc-400">
            Remember your password?{' '}
            <Link
              href="/auth/login"
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

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={<GlobalLoading />}>
      <ForgotPasswordForm />
    </Suspense>
  )
}
