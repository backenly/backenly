'use client'

import { useEffect } from 'react'

// Guards against double-initialization across React re-renders, Fast Refresh,
// and any accidental second mount during the app lifecycle.
let initialized = false

/**
 * Client-only Amplitude analytics initializer. Page views and sessions only.
 *
 * ── WHY THIS IMPORTS `@amplitude/analytics-browser` AND NOT `@amplitude/unified`
 *
 * It used to call `initAll()` from `@amplitude/unified` with
 * `sessionReplay: { sampleRate: 1 }` — session replay on 100% of sessions.
 * This component is mounted in the ROOT layout, so that covered the
 * authenticated console at /app/* as well as the marketing pages: every
 * interaction with the data browser, the schema editor and the SQL surface was
 * being recorded, including table names, column names and whatever customer
 * rows happened to be on screen. None of it was disclosed in the privacy
 * policy. That is the reason for the change; the rest of this comment is the
 * reason for the shape of it.
 *
 * The obvious fix — check the pathname and skip replay under /app — does not
 * work here, for two structural reasons:
 *
 *   1. This component initializes ONCE per browser session (the `initialized`
 *      flag above) and never re-evaluates. A visitor who lands on /pricing,
 *      initializes with replay, then client-navigates to /app carries the
 *      replay plugin across the navigation. The pathname check would pass and
 *      the recording would continue.
 *   2. There is no marketing route group. app/comparisons, app/pricing and the
 *      rest are siblings of app/app/, so the only shared ancestor is the root
 *      layout — which is also the dashboard's ancestor. There is no segment
 *      that covers marketing but not /app.
 *
 * Tearing replay down on navigation is not an answer either: shutdown is async,
 * the plugin can have buffered frames from the transition, and a guarantee that
 * depends on cleanup winning a race is not a guarantee.
 *
 * So the plugin must never be loaded at all. `@amplitude/unified` cannot do
 * that: it exports no `init` (only `initAll`), and it depends on
 * @amplitude/plugin-session-replay-browser at its module top level, so merely
 * importing it puts replay in the bundle whatever the config says.
 * `@amplitude/analytics-browser` exports `init` and does not depend on the
 * replay plugin at all. Replay is therefore absent by construction here, not
 * switched off by a flag someone can flip back.
 *
 * ── WHY `autocapture` IS AN OBJECT AND NOT `true`
 *
 * It was `autocapture: true`. In the SDK's own gates
 * (@amplitude/analytics-browser/lib/cjs/default-tracking.js) every capability
 * check begins `if (typeof autocapture === 'boolean') { return autocapture }`,
 * so the boolean turns on EVERY option — including the five that default to
 * false when the same field is passed as an object: elementInteractions,
 * frustrationInteractions, networkTracking, webVitals and performanceTracking.
 *
 * elementInteractions is the expensive one: it captures the text and CSS
 * selector of clicked elements, which on the dashboard means table names,
 * column names, project names, and the contents of buttons rendered from
 * customer data. networkTracking captures request metadata. Both were on.
 *
 * Passing an object makes every capture decision visible in the diff. Adding
 * one later is a deliberate line change that gets reviewed and disclosed,
 * rather than an invisible consequence of a boolean.
 *
 * Every flag below is listed explicitly, including the ones whose SDK default
 * already matches, so that a default change upstream cannot quietly widen what
 * we collect. scripts/verify-analytics-posture.ts fails the build if this
 * shape drifts.
 */
export function AmplitudeAnalytics() {
  useEffect(() => {
    if (initialized) return
    initialized = true

    import('@amplitude/analytics-browser')
      .then((amplitude) => {
        amplitude.init('bdf590ed8d5b944d345d0db52031c515', {
          autocapture: {
            // ── Kept: page-level product analytics ────────────────────────
            pageViews: true,
            sessions: true,

            // ── Off: everything that reads the DOM, the network, or the
            //    user's behaviour in detail. Re-enabling any of these is a
            //    privacy-policy change, not a config tweak.
            attribution: false,
            elementInteractions: false,
            formInteractions: false,
            fileDownloads: false,
            frustrationInteractions: false,
            networkTracking: false,
            webVitals: false,
            performanceTracking: false,
          },
        })
      })
      .catch((err) => {
        // Never let analytics loading break the app.
        console.error('Amplitude failed to initialize', err)
      })
  }, [])

  return null
}
