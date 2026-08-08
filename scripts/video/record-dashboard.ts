/**
 * DASHBOARD DEMO RECORDER
 * =======================
 *
 * Records the browser half of the product demo at a viewport that is locked to
 * the output frame size. That lock is the entire point of this script.
 *
 * The previous take was captured with a browser wider than the 1920px frame, so
 * the right column of every dashboard page was cut mid-word:
 *
 *   "Safe fixes ship on their own. Everything risky w…"
 *   "…violates foreign key constraint \"fk_pro…"
 *
 * Those pixels never existed in the file, so no crop or scale in post can
 * recover them. Here, layout width and frame width are the same literal
 * constant (FRAME), so the failure is unreachable by construction.
 *
 * What this does NOT do: re-shoot the terminal section. That footage is a real
 * Claude Code session driving real MCP tools, with real latencies (494ms,
 * 3290ms, 161ms, 187ms, 92ms). It is unclipped and it is the reason the video
 * reads as genuine. It is spliced back in unmodified by the compose step.
 *
 * Playwright does not draw the OS cursor into its recording, so a synthetic
 * pointer is injected into the page and tweened. Zoom is a CSS transform on
 * <html> rather than an ffmpeg zoompan, because transforming before rasterisation
 * keeps text sharp at every scale, where zoompan would resample and soften it.
 *
 * Usage:
 *   BACKENLY_BASE_URL=https://backenly.com \
 *   BACKENLY_PROJECT_ID=<id> \
 *   BACKENLY_STORAGE_STATE=/abs/path/state.json \
 *   npx tsx scripts/video/record-dashboard.ts
 *
 * Credentials are never read from, or written to, this repository.
 */

import { chromium, type Page } from '@playwright/test'
import { mkdirSync } from 'fs'
import { resolve } from 'path'

const FRAME = { width: 1920, height: 1080 } as const

const BASE_URL = process.env.BACKENLY_BASE_URL ?? 'https://backenly.com'
const PROJECT_ID = process.env.BACKENLY_PROJECT_ID
const STORAGE_STATE = process.env.BACKENLY_STORAGE_STATE
const OUT_DIR = resolve(process.env.BACKENLY_VIDEO_OUT ?? './.video-out')

if (!PROJECT_ID) throw new Error('BACKENLY_PROJECT_ID is required')
if (!STORAGE_STATE) throw new Error('BACKENLY_STORAGE_STATE is required (run auth-state.ts first)')

/** Wall-clock pacing. Playwright records in real time, so waits ARE the edit. */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * A pointer the recording can actually see.
 *
 * Playwright's `mouse` moves a real input pointer, which the video encoder never
 * observes. Every frame of cursor motion in the output is this element.
 */
async function injectCursor(page: Page) {
  await page.addStyleTag({
    content: `
      #__demo_cursor {
        position: fixed; top: 0; left: 0; z-index: 2147483647;
        width: 22px; height: 22px; pointer-events: none;
        margin: -2px 0 0 -2px;
        transition: transform 40ms linear;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,.55));
      }
      #__demo_cursor.__click::after {
        content: ''; position: absolute; inset: -10px;
        border-radius: 50%; border: 2px solid rgba(255,255,255,.85);
        animation: __demo_ping 420ms ease-out forwards;
      }
      @keyframes __demo_ping {
        from { transform: scale(.35); opacity: .9 }
        to   { transform: scale(1);   opacity: 0 }
      }
    `,
  })
  await page.evaluate(() => {
    const el = document.createElement('div')
    el.id = '__demo_cursor'
    el.innerHTML =
      '<svg viewBox="0 0 24 24" width="22" height="22">' +
      '<path d="M5 2l14 8.5-6.2 1.2L9.6 19 5 2z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/>' +
      '</svg>'
    document.body.appendChild(el)
    ;(window as any).__cursorTo = (x: number, y: number) => {
      const c = document.getElementById('__demo_cursor')
      if (c) c.style.transform = `translate(${x}px, ${y}px)`
    }
  })
  // Park it centre-frame so the first move tweens from a known point.
  await page.evaluate(
    ([x, y]) => (window as any).__cursorTo(x, y),
    [FRAME.width / 2, FRAME.height / 2] as const
  )
}

/** Ease-in-out cubic. Linear pointer motion is the tell that a demo is scripted. */
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

async function moveCursor(page: Page, to: { x: number; y: number }, ms = 700) {
  const from = await page.evaluate(() => {
    const c = document.getElementById('__demo_cursor')
    const m = c?.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/)
    return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : { x: 960, y: 540 }
  })
  const steps = Math.max(2, Math.round(ms / 16))
  for (let i = 1; i <= steps; i++) {
    const t = easeInOut(i / steps)
    const x = from.x + (to.x - from.x) * t
    const y = from.y + (to.y - from.y) * t
    await page.evaluate(([x, y]) => (window as any).__cursorTo(x, y), [x, y] as const)
    await wait(16)
  }
}

async function clickPulse(page: Page) {
  await page.evaluate(() => {
    const c = document.getElementById('__demo_cursor')
    if (!c) return
    c.classList.add('__click')
    setTimeout(() => c.classList.remove('__click'), 460)
  })
  await wait(460)
}

/**
 * Scroll with an explicit tween instead of `behavior:'smooth'`.
 *
 * The native smooth scroll picks its own duration, which differs per engine and
 * per distance, so shot lengths drift between takes and the caption timings no
 * longer line up. This is deterministic.
 */
async function smoothScroll(page: Page, toY: number, ms = 1400) {
  await page.evaluate(
    async ([toY, ms]) => {
      const from = window.scrollY
      const delta = toY - from
      const start = performance.now()
      await new Promise<void>((done) => {
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / ms)
          const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
          window.scrollTo(0, from + delta * e)
          t < 1 ? requestAnimationFrame(tick) : done()
        }
        requestAnimationFrame(tick)
      })
    },
    [toY, ms] as const
  )
}

/**
 * Zoom via CSS transform on <html>.
 *
 * Done pre-raster so glyphs are re-rendered at the target scale and stay crisp.
 * An ffmpeg zoompan on the finished frames would resample and blur exactly the
 * small text (error codes, latencies) that makes this demo believable.
 */
async function zoomTo(page: Page, scale: number, origin: { x: number; y: number }, ms = 900) {
  await page.evaluate(
    ([scale, ox, oy, ms]) => {
      const h = document.documentElement
      h.style.transition = `transform ${ms}ms cubic-bezier(.4,0,.2,1)`
      h.style.transformOrigin = `${ox}px ${oy}px`
      h.style.transform = `scale(${scale})`
    },
    [scale, origin.x, origin.y, ms] as const
  )
  await wait(ms + 80)
}

async function resetZoom(page: Page, ms = 700) {
  await page.evaluate(([ms]) => {
    const h = document.documentElement
    h.style.transition = `transform ${ms}ms cubic-bezier(.4,0,.2,1)`
    h.style.transform = 'scale(1)'
  }, [ms] as const)
  await wait(ms + 80)
}

/** Let network + layout settle so no shot opens on a skeleton. */
async function settle(page: Page, ms = 900) {
  await page.waitForLoadState('networkidle').catch(() => {})
  await wait(ms)
}

/**
 * Shot sequence, mirroring the source video section for section.
 * Durations are tuned so total runtime lands near the original 48.9s of
 * dashboard footage (source 66.4s minus the 17.5s terminal section).
 */
async function run(page: Page) {
  const p = (path = '') => `${BASE_URL}/app/projects/${PROJECT_ID}${path}`

  // 1. Database — "A real Postgres database. Your tables, your rows."  (~5.5s)
  await page.goto(p('/database'), { waitUntil: 'domcontentloaded' })
  await settle(page, 1200)
  await injectCursor(page)
  await moveCursor(page, { x: 620, y: 430 }, 800)
  await zoomTo(page, 1.15, { x: 700, y: 420 }, 900)
  await wait(1600)
  await resetZoom(page)

  // 2. Auth & Users — "End-user auth, governed by the same policies."  (~6s)
  await page.goto(p('/auth'), { waitUntil: 'domcontentloaded' })
  await settle(page, 1100)
  await injectCursor(page)
  await moveCursor(page, { x: 300, y: 300 }, 700)
  await clickPulse(page)
  await smoothScroll(page, 260, 1200)
  await wait(1800)

  // 3. Connect — "One endpoint for every agent. Scoped keys, revocable."  (~6s)
  await page.goto(p('/connect'), { waitUntil: 'domcontentloaded' })
  await settle(page, 1100)
  await injectCursor(page)
  await moveCursor(page, { x: 1240, y: 330 }, 800)
  await clickPulse(page)
  await zoomTo(page, 1.18, { x: 1100, y: 380 }, 900)
  await wait(1700)
  await resetZoom(page)

  // 4. Overview — the self-healing loop.  (~17s, the longest beat)
  await page.goto(p(''), { waitUntil: 'domcontentloaded' })
  await settle(page, 1400)
  await injectCursor(page)
  await wait(1400)
  await smoothScroll(page, 300, 1500)
  await zoomTo(page, 1.12, { x: 960, y: 380 }, 900)
  await wait(2600)
  await resetZoom(page)
  await smoothScroll(page, 700, 1600)
  await wait(2400)
  await smoothScroll(page, 1150, 1500)
  await wait(2200)

  // 5. Autonomy — the escalation, and the strongest beat in the video.  (~13s)
  await page.goto(p('/autonomy'), { waitUntil: 'domcontentloaded' })
  await settle(page, 1400)
  await injectCursor(page)
  await wait(1200)
  await zoomTo(page, 1.16, { x: 860, y: 300 }, 900)
  await wait(3000) // dwell on the escalated FK finding and its reason text
  await resetZoom(page)
  await smoothScroll(page, 620, 1600)
  await wait(2600)
  await smoothScroll(page, 1080, 1400)
  await wait(2200)
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })

  const browser = await chromium.launch({
    args: [`--window-size=${FRAME.width},${FRAME.height}`, '--hide-scrollbars', '--force-device-scale-factor=1'],
  })

  const context = await browser.newContext({
    storageState: STORAGE_STATE,
    viewport: FRAME,            // layout width === frame width. The whole fix.
    deviceScaleFactor: 1,
    recordVideo: { dir: OUT_DIR, size: FRAME },
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
  })

  const page = await context.newPage()
  page.setDefaultTimeout(45_000)

  try {
    await run(page)
  } finally {
    await page.close()
    await context.close()
    await browser.close()
  }

  console.log(`\nRaw dashboard footage written to ${OUT_DIR}`)
  console.log('Next: scripts/video/compose.sh to burn captions and splice the terminal section.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
