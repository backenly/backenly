'use client'

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { analyticsAllowed, clearAnalyticsStorage, CONSENT_EVENT } from '@/lib/consent'

function subscribe(onChange: () => void) {
  window.addEventListener(CONSENT_EVENT, onChange)
  return () => window.removeEventListener(CONSENT_EVENT, onChange)
}

/**
 * Renders the analytics initializer (app/layout.tsx wraps the Cloud mount in
 * this) only once analytics are allowed, so before a choice, after "Reject
 * all", and under Global Privacy Control, Amplitude's code never loads.
 *
 * Withdrawing consent after analytics started clears Amplitude's cookies and
 * storage and reloads the page, so the SDK already in memory goes with it.
 * Identifiers left from before this choice existed are cleared too.
 */
export function ConsentGate({ children }: { children: ReactNode }) {
  const allowed = useSyncExternalStore(subscribe, () => analyticsAllowed(), () => false)
  const started = useRef(false)

  useEffect(() => {
    if (allowed) {
      started.current = true
      return
    }
    clearAnalyticsStorage()
    if (started.current) window.location.reload()
  }, [allowed])

  return allowed ? <>{children}</> : null
}
