'use client'

/**
 * Whether to ask "How do you want to start?", and recording the answer.
 *
 * The answer is kept with the person's other one-time tours (GET and POST
 * /api/tours, id `start-choice`), so it holds on every device. This browser
 * remembers it too, so a write that did not land (the tours table missing,
 * the network) does not bring the question back on the next visit. Unsure
 * means do not ask: a read that fails, or a tours record that is not
 * available yet, keeps the question closed, the way the console tour does.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export const START_CHOICE_TOUR = 'start-choice'
const LOCAL_KEY = 'backenly:start-choice'

function answeredHere(): boolean {
  try {
    return localStorage.getItem(LOCAL_KEY) === 'answered'
  } catch {
    return false
  }
}

function rememberHere() {
  try {
    localStorage.setItem(LOCAL_KEY, 'answered')
  } catch {
    /* private window: the server's record still holds */
  }
}

/**
 * `eligible`: everything the page knows says the question fits (an owner or
 * admin, an organization with no projects, room on the plan, importing
 * offered). Only then is the tours record read.
 */
export function useStartChoice(eligible: boolean): { ask: boolean; answer: () => void } {
  const [ask, setAsk] = useState(false)
  const answered = useRef(false)

  useEffect(() => {
    if (!eligible || answered.current || answeredHere()) return
    let cancelled = false
    fetch('/api/tours', { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { available?: boolean; seen?: unknown } | null) => {
        if (cancelled || !data?.available) return
        const seen = Array.isArray(data.seen) ? data.seen : []
        if (seen.includes(START_CHOICE_TOUR)) {
          rememberHere()
          return
        }
        setAsk(true)
      })
      .catch(() => {
        /* unsure means do not ask */
      })
    return () => {
      cancelled = true
    }
  }, [eligible])

  // Answering and closing are the same record: the question is asked once.
  const answer = useCallback(() => {
    if (answered.current) return
    answered.current = true
    rememberHere()
    setAsk(false)
    fetch('/api/tours', {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tourId: START_CHOICE_TOUR }),
    }).catch(() => {})
  }, [])

  return { ask: ask && eligible, answer }
}
