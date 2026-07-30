'use client'

/**
 * Verification wall for accounts flagged untrusted at signup.
 *
 * Replaces a 403 buried inside project creation. Erroring deep in a flow tells
 * someone what they cannot do at the worst possible moment and offers no way
 * out; a wall at the entrance states the one required action, provides the
 * button that performs it, and a way to leave. Every platform in this category
 * converged on the same shape for the same reason.
 *
 * WHO SEES THIS
 * Only `trustLevel === 'untrusted' && !emailVerified`. That is deliberate and
 * narrow: 21 existing accounts are unverified but trusted (they signed up
 * before the gate existed), and keying the wall on `!emailVerified` alone would
 * lock every one of them out of a product they already use.
 *
 * This is UX, not enforcement. The server gate in lib/auth/account-standing.ts
 * stays exactly where it is — a wall rendered in the browser is trivially
 * skipped with a direct API call, which is precisely what a bot does.
 */

import { useState } from 'react'
// lucide-react, not Iconify: the app shell never calls registerSiteIcons(), and
// the registry only bundles the solar/ri/si collections anyway, so Iconify names
// would have rendered as empty boxes here.
import { Mail, CheckCircle2, Loader2 } from 'lucide-react'

interface VerifyEmailWallProps {
  email: string
  /** Called after the user logs out, so the shell can route away. */
  onLogout: () => void
}

type SendState = 'idle' | 'sending' | 'sent' | 'throttled' | 'error'

export function VerifyEmailWall({ email, onLogout }: VerifyEmailWallProps) {
  const [state, setState] = useState<SendState>('idle')

  const resend = async () => {
    setState('sending')
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('auth-token') : null
      const res = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      })
      if (res.status === 429) {
        setState('throttled')
        return
      }
      setState(res.ok ? 'sent' : 'error')
    } catch {
      setState('error')
    }
  }

  return (
    <div className="min-h-screen bg-black flex items-center justify-center px-5">
      <div className="w-full max-w-[440px] rounded-2xl border border-white/[0.10] bg-[#16171d] p-8 shadow-[0_24px_64px_-32px_rgba(0,0,0,0.9)]">
        <div className="flex justify-center mb-6">
          <div className="w-11 h-11 rounded-xl border border-violet-500/25 bg-violet-500/10 flex items-center justify-center">
            <Mail className="w-5 h-5 text-violet-300" />
          </div>
        </div>

        <h1 className="text-[19px] font-semibold text-white text-center tracking-tight">
          Verify your email to start building
        </h1>

        <p className="mt-3 text-[13px] leading-relaxed text-zinc-400 text-center">
          We sent a link to{' '}
          <span className="text-zinc-200 font-medium break-all">{email}</span>. Click it to
          activate your account.
        </p>

        <button
          type="button"
          onClick={resend}
          disabled={state === 'sending' || state === 'sent'}
          className="mt-6 w-full inline-flex items-center justify-center gap-2 rounded-lg border border-white/[0.12] bg-white/[0.05] px-4 py-2.5 text-[13px] font-medium text-zinc-100 transition-colors hover:bg-white/[0.09] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {state === 'sending' ? (
            <>
              <Loader2 className="w-[15px] h-[15px] animate-spin" />
              Sending…
            </>
          ) : state === 'sent' ? (
            <>
              <CheckCircle2 className="w-[15px] h-[15px] text-emerald-400" />
              Email sent
            </>
          ) : (
            <>
              <Mail className="w-[15px] h-[15px]" />
              Resend email
            </>
          )}
        </button>

        {state === 'throttled' && (
          <p className="mt-3 text-[11.5px] text-amber-400/90 text-center">
            Too many requests. Please wait a few minutes before trying again.
          </p>
        )}
        {state === 'error' && (
          <p className="mt-3 text-[11.5px] text-amber-400/90 text-center">
            Could not send just now. Please try again shortly.
          </p>
        )}

        <p className="mt-5 text-[11.5px] leading-relaxed text-zinc-500 text-center">
          Don&apos;t see it? Check your spam folder. Already clicked the link?{' '}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="text-zinc-300 hover:text-white underline underline-offset-2"
          >
            Refresh
          </button>
          .
        </p>

        <div className="mt-6 pt-5 border-t border-white/[0.06] text-center">
          <button
            type="button"
            onClick={onLogout}
            className="text-[12px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}
