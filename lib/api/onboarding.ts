// Client-side API helpers for the Getting Started guide (app/api/onboarding).

import type { GuideAction, GuideState, StepId } from '@/lib/onboarding/guide'

export type { GuideAction, GuideState }

export class GuideRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
  }
}

async function send(init?: RequestInit): Promise<GuideState> {
  const res = await fetch('/api/onboarding', { credentials: 'include', cache: 'no-store', ...init })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new GuideRequestError(data?.error || `HTTP ${res.status}`, res.status, data?.code)
  return data as GuideState
}

export function fetchGuide(): Promise<GuideState> {
  return send()
}

function post(body: Record<string, unknown>): Promise<GuideState> {
  return send({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

export const dismissGuide = () => post({ action: 'dismiss' })
export const reopenGuide = () => post({ action: 'reopen' })

/** Fire-and-forget: an interaction that fails to report changes nothing the user sees. */
export function trackGuide(event: GuideAction, step?: StepId | null): void {
  fetch('/api/onboarding', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'track', event, step: step ?? null }),
  }).catch(() => {})
}
