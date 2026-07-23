'use client'

import { useEffect } from 'react'

// Guards against double-initialization across React re-renders, Fast Refresh,
// and any accidental second mount during the app lifecycle.
let initialized = false

/**
 * Client-only Amplitude Analytics + Session Replay initializer.
 *
 * The SDK is loaded via a dynamic import inside useEffect so it never enters
 * the server render / prerender path — it resolves and runs only in the
 * browser. Mounted once in the root layout so it applies to every page.
 */
export function AmplitudeAnalytics() {
  useEffect(() => {
    if (initialized) return
    initialized = true

    import('@amplitude/unified')
      .then((amplitude) => {
        amplitude.initAll('bdf590ed8d5b944d345d0db52031c515', {
          analytics: { autocapture: true },
          sessionReplay: { sampleRate: 1 },
        })
      })
      .catch((err) => {
        // Never let analytics loading break the app.
        console.error('Amplitude failed to initialize', err)
      })
  }, [])

  return null
}
