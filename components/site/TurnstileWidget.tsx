'use client'

/**
 * Cloudflare Turnstile widget.
 *
 * Renders nothing at all when NEXT_PUBLIC_TURNSTILE_SITE_KEY is unset, so the
 * signup form is unchanged until the keys exist. The server mirrors this: it
 * only enforces once TURNSTILE_SECRET_KEY is present. Both halves have to be
 * configured for the gate to close, and neither half breaks on its own.
 *
 * For the large majority of visitors this is a non-interactive check — no image
 * grids, no "select all the buses". It renders a small status strip and clears
 * itself.
 */

import { useEffect, useRef, useCallback } from 'react'

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string
      remove: (id: string) => void
      reset: (id?: string) => void
    }
    onloadTurnstileCallback?: () => void
  }
}

const SCRIPT_ID = 'cf-turnstile-script'
const SCRIPT_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onloadTurnstileCallback'

export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || ''
export const isTurnstileEnabled = Boolean(TURNSTILE_SITE_KEY)

interface TurnstileWidgetProps {
  /** Receives the solve token, or null when it expires / errors out. */
  onToken: (token: string | null) => void
  /** Rendered inside an auth card, so dark is the only sensible default. */
  theme?: 'dark' | 'light' | 'auto'
  className?: string
}

export function TurnstileWidget({ onToken, theme = 'dark', className }: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)
  // Held in a ref so re-renders of the parent never re-run the render effect —
  // remounting the widget mid-solve is what causes duplicate-token errors.
  const onTokenRef = useRef(onToken)
  onTokenRef.current = onToken

  const renderWidget = useCallback(() => {
    if (!containerRef.current || !window.turnstile || widgetIdRef.current) return
    widgetIdRef.current = window.turnstile.render(containerRef.current, {
      sitekey: TURNSTILE_SITE_KEY,
      theme,
      size: 'flexible',
      callback: (token: string) => onTokenRef.current(token),
      'expired-callback': () => onTokenRef.current(null),
      'error-callback': () => onTokenRef.current(null),
    })
  }, [theme])

  useEffect(() => {
    if (!isTurnstileEnabled) return

    if (window.turnstile) {
      renderWidget()
    } else if (!document.getElementById(SCRIPT_ID)) {
      window.onloadTurnstileCallback = renderWidget
      const script = document.createElement('script')
      script.id = SCRIPT_ID
      script.src = SCRIPT_SRC
      script.async = true
      script.defer = true
      document.head.appendChild(script)
    } else {
      // Script is in flight from a previous mount — chain onto its onload.
      const previous = window.onloadTurnstileCallback
      window.onloadTurnstileCallback = () => {
        previous?.()
        renderWidget()
      }
    }

    return () => {
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current)
        } catch {
          // Widget already torn down by a navigation — nothing to clean up.
        }
      }
      widgetIdRef.current = null
    }
  }, [renderWidget])

  if (!isTurnstileEnabled) return null

  return <div ref={containerRef} className={className} />
}

/** Reset the active widget so a new token can be issued after a failed submit. */
export function resetTurnstile() {
  try {
    window.turnstile?.reset()
  } catch {
    // No widget mounted.
  }
}
