'use client'

/**
 * Shown in a delete dialog when the server answers REAUTH_REQUIRED: deleting a
 * project or an account needs a sign-in from the last ten minutes
 * (lib/auth/recent-sign-in.ts).
 *
 *   Deleting needs a sign-in from the last 10 minutes.
 *   Password  [••••••••••]                         [Confirm password]
 *
 * A password account confirms in place. The password goes to the sign-in route,
 * so its limits, lockout and second factor apply (the authenticator code is
 * asked for when the account has one), and the deletion then runs on the new
 * sign-in. A Google or GitHub account signs in with its provider again and
 * comes back to this page. Any other account signs out and in again.
 */
import { useState } from 'react'
import { KitButton, KitField, KitInput } from '@/components/inspector/kit'
import { RefusedLine } from '@/components/console/states'
import { LoginError, reauthenticate, signOut } from '@/lib/api/auth'
import type { Reauthentication } from '@/lib/api/projects'

const PROVIDER_NAME = { google: 'Google', github: 'GitHub' } as const

/** This page, to come back to after signing in again. */
function here(): string {
  return `${window.location.pathname}${window.location.search}`
}

export function SignInAgain({ reauth, onSignedIn }: { reauth: Reauthentication; onSignedIn: () => void }) {
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [needsCode, setNeedsCode] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const inPlace = reauth.password && !!reauth.email

  const confirm = async () => {
    if (!inPlace || !password || busy) return
    if (needsCode && !code.trim()) {
      setError('Enter the code from your authenticator app, or a backup code.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await reauthenticate({ email: reauth.email!, password, ...(needsCode ? { totpCode: code.trim() } : {}) })
      onSignedIn()
    } catch (err) {
      const refused = err instanceof LoginError ? err.code : null
      if (refused === 'TOTP_REQUIRED') {
        setNeedsCode(true)
      } else if (refused === 'TOTP_INVALID') {
        setError('That code is not valid. Check your authenticator app and try again.')
      } else {
        setError(err instanceof Error ? err.message : 'Could not sign you in. Try again.')
      }
    } finally {
      setBusy(false)
    }
  }

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void confirm()
    }
  }

  return (
    <div className="mt-4 border-t border-white/[0.06] pt-4">
      <p className="text-[13px] leading-[20px] text-zinc-300">Deleting needs a sign-in from the last 10 minutes.</p>
      {inPlace ? (
        <div className="mt-3 space-y-3">
          <KitField label="Password">
            <KitInput
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={onEnter}
              disabled={busy}
              autoFocus
            />
          </KitField>
          {needsCode && (
            <KitField label="Authenticator code">
              <KitInput
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={onEnter}
                disabled={busy}
                autoFocus
              />
            </KitField>
          )}
          <div className="flex justify-end">
            <KitButton size="sm" onClick={() => void confirm()} loading={busy} disabled={!password}>
              Confirm password
            </KitButton>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex justify-end">
          {reauth.provider ? (
            <KitButton
              size="sm"
              onClick={() => {
                // A full navigation, as the sign-in page starts it: an API route that sends the
                // browser to the provider, which sends it back here. Not a page the router can open.
                // eslint-disable-next-line @next/next/no-location-assign-relative-destination
                window.location.href = `/api/auth/platform-${reauth.provider}?redirect=${encodeURIComponent(here())}`
              }}
            >
              Sign in again with {PROVIDER_NAME[reauth.provider]}
            </KitButton>
          ) : (
            <KitButton
              size="sm"
              onClick={() => {
                signOut(`/auth/login?redirect=${encodeURIComponent(here())}`).catch(() =>
                  setError('Could not sign you out. Try again.'),
                )
              }}
            >
              Sign out and sign in again
            </KitButton>
          )}
        </div>
      )}
      {error && <RefusedLine className="mt-[10px]">{error}</RefusedLine>}
    </div>
  )
}
