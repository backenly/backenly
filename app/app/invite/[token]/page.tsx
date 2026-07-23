'use client'

/**
 * Accept-invite page (/app/invite/[token]) — IA restructure §5.3.
 *
 * Opens from the invite email. If the visitor isn't signed in, we bounce them
 * to login with a redirect back here (so acceptance resumes after auth). Once
 * signed in, POST /api/org/invites/accept adds the membership and forwards to
 * the org's projects. `token` is a route param (not a search param), so no
 * useSearchParams / Suspense concern here.
 */

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Loader2, Check, AlertCircle } from 'lucide-react'
import { AuthChrome, AuthCard } from '@/components/site/AuthShell'

type State =
  | { kind: 'working' }
  | { kind: 'ok'; orgName?: string; orgId?: string }
  | { kind: 'error'; message: string }

export default function AcceptInvitePage() {
  const params = useParams()
  const router = useRouter()
  const token = params.token as string
  const [state, setState] = useState<State>({ kind: 'working' })

  useEffect(() => {
    let cancelled = false
    async function run() {
      // Must be signed in — the invite is bound to a specific email.
      const me = await fetch('/api/auth/me', { credentials: 'include' })
      if (me.status === 401) {
        router.push(`/auth/login?redirect=${encodeURIComponent(`/app/invite/${token}`)}`)
        return
      }
      const res = await fetch('/api/org/invites/accept', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const j = await res.json().catch(() => ({}))
      if (cancelled) return
      if (res.ok && j.success) {
        setState({ kind: 'ok', orgName: j.data?.orgName, orgId: j.data?.orgId })
        setTimeout(() => router.push('/app'), 1400)
      } else {
        setState({ kind: 'error', message: j.error ?? 'This invite could not be accepted.' })
      }
    }
    run()
    return () => { cancelled = true }
  }, [token, router])

  return (
    <AuthChrome>
      <AuthCard eyebrow="Team invite" title="Joining a team on Backenly" subtitle="Confirming your invitation…">
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          {state.kind === 'working' && (
            <>
              <Loader2 className="h-7 w-7 animate-spin text-violet-300" />
              <p className="text-[13px] text-zinc-400">Accepting your invite…</p>
            </>
          )}
          {state.kind === 'ok' && (
            <>
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-500/15 ring-1 ring-emerald-400/30">
                <Check className="h-5 w-5 text-emerald-300" />
              </div>
              <p className="text-[14px] font-medium text-zinc-100">You’re in{state.orgName ? `. Welcome to ${state.orgName}` : ''}.</p>
              <p className="text-[12.5px] text-zinc-500">Taking you to your projects…</p>
            </>
          )}
          {state.kind === 'error' && (
            <>
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-rose-500/15 ring-1 ring-rose-400/30">
                <AlertCircle className="h-5 w-5 text-rose-300" />
              </div>
              <p className="text-[13.5px] text-zinc-200">{state.message}</p>
              <button
                onClick={() => router.push('/app')}
                className="mt-1 inline-flex h-9 items-center rounded-md bg-white px-4 text-[12.5px] font-semibold text-black hover:bg-zinc-200"
              >
                Go to Backenly
              </button>
            </>
          )}
        </div>
      </AuthCard>
    </AuthChrome>
  )
}
