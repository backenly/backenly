'use client'

import { useEffect } from 'react'
import { invalidateSessionCache, useUserSession } from '@/lib/hooks/useUserSession'

/**
 * Google One Tap: the Google prompt in the corner of the page that signs a
 * visitor up, or in, with the Google account their browser already knows.
 *
 * Renders nothing of its own. Google draws the prompt (the browser itself
 * does, where it supports FedCM), so there is no markup here to style and
 * nothing on the page moves.
 *
 * It asks only when all of these hold:
 *   - the visitor is signed out;
 *   - this deployment has Google sign-in configured (the client id comes from
 *     /api/auth/platform-providers, so a self-hosted install without Google
 *     never loads Google's script at all);
 *   - the address carries no `error` (the visitor was just refused, and is
 *     reading why) and no `setup_token` (a self-hosted deployment is being
 *     claimed, which a Google sign-in cannot do).
 *
 * Nothing is chosen for the visitor: `auto_select` is off, so an account is
 * created or signed in only after they pick one in the prompt. The token
 * Google returns is posted to /api/auth/platform-google/one-tap, which
 * verifies it and sets the session cookie; this component never keeps it.
 *
 * Browsers that block third-party sign-in prompts (Safari, Firefox) show
 * nothing, and the page's own Google button still works there.
 */

const GSI_SRC = 'https://accounts.google.com/gsi/client'

/** Refusals the login page explains (lib/auth/oauth/google-sign-in.ts). */
const EXPLAINED = new Set([
  'email_not_verified',
  'blocked',
  'second_factor_required',
  'claim_requires_setup_token',
  'signup_not_allowed',
  'oauth_failed',
])

type GoogleIdApi = {
  initialize: (options: Record<string, unknown>) => void
  prompt: () => void
  cancel: () => void
}

function googleId(): GoogleIdApi | null {
  return (window as unknown as { google?: { accounts?: { id?: GoogleIdApi } } }).google?.accounts?.id ?? null
}

let clientIdPromise: Promise<string | null> | null = null
function googleClientId(): Promise<string | null> {
  clientIdPromise ??= fetch('/api/auth/platform-providers')
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => (typeof data?.googleClientId === 'string' && data.googleClientId ? data.googleClientId : null))
    .catch(() => null)
  return clientIdPromise
}

let scriptPromise: Promise<boolean> | null = null
function loadGoogleScript(): Promise<boolean> {
  scriptPromise ??= new Promise<boolean>((resolve) => {
    if (googleId()) return resolve(true)
    const script = document.createElement('script')
    script.src = GSI_SRC
    script.async = true
    script.onload = () => resolve(!!googleId())
    script.onerror = () => resolve(false)
    document.head.appendChild(script)
  })
  return scriptPromise
}

async function signInWithCredential(credential: string): Promise<void> {
  const redirect = new URLSearchParams(window.location.search).get('redirect')
  let res: Response
  try {
    res = await fetch('/api/auth/platform-google/one-tap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ credential, ...(redirect ? { redirect } : {}) }),
    })
  } catch {
    // The page is still usable; its own sign-in buttons are right there.
    return
  }
  const data = await res.json().catch(() => null)
  if (res.ok && data?.ok) {
    invalidateSessionCache()
    window.location.assign(typeof data.redirectTo === 'string' ? data.redirectTo : '/app')
    return
  }
  if (typeof data?.error === 'string' && EXPLAINED.has(data.error)) {
    window.location.assign(`/auth/login?error=${encodeURIComponent(data.error)}`)
  }
}

export function GoogleOneTap({ context = 'signup' }: { context?: 'signup' | 'signin' }) {
  const { isLoggedIn, isLoading } = useUserSession()

  useEffect(() => {
    if (isLoading || isLoggedIn) return
    const query = new URLSearchParams(window.location.search)
    if (query.has('error') || query.has('setup_token')) return

    let cancelled = false
    let prompted = false
    ;(async () => {
      const clientId = await googleClientId()
      if (!clientId || cancelled) return
      if (!(await loadGoogleScript()) || cancelled) return
      const api = googleId()
      if (!api) return
      api.initialize({
        client_id: clientId,
        callback: (response: { credential?: string }) => {
          if (response?.credential) void signInWithCredential(response.credential)
        },
        auto_select: false,
        cancel_on_tap_outside: false,
        context,
        use_fedcm_for_prompt: true,
      })
      api.prompt()
      prompted = true
    })()

    return () => {
      cancelled = true
      if (prompted) googleId()?.cancel()
    }
  }, [isLoading, isLoggedIn, context])

  return null
}
