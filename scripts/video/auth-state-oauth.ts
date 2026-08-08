/**
 * INTERACTIVE LOGIN -> PLAYWRIGHT storageState (OAuth accounts)
 * =============================================================
 *
 * For accounts that sign in with "Continue with Google" / GitHub, there is no
 * password to hand to a script. This opens a real browser window on your screen,
 * waits while YOU complete the sign-in by hand, then saves the resulting session
 * so the recorder can reuse it.
 *
 * No credential ever passes through the terminal, the repo, or a chat transcript.
 *
 * It also lists your projects afterwards, so you do not have to go hunting for a
 * project id in a URL.
 *
 * Google sometimes refuses to sign in inside an automated browser
 * ("this browser or app may not be secure"). We therefore prefer your real
 * installed Chrome over Playwright's bundled Chromium, which it accepts far
 * more often. If it still refuses, see FALLBACK at the bottom of this file.
 *
 * Usage:
 *   BACKENLY_STORAGE_STATE=/abs/path/outside/repo/state.json \
 *   npx tsx scripts/video/auth-state-oauth.ts
 */

import { chromium, type BrowserContext } from '@playwright/test'
import { resolve, dirname } from 'path'
import { mkdirSync } from 'fs'

const BASE_URL = process.env.BACKENLY_BASE_URL ?? 'https://backenly.com'
const OUT = process.env.BACKENLY_STORAGE_STATE
if (!OUT) throw new Error('BACKENLY_STORAGE_STATE (absolute output path) is required')

const outPath = resolve(OUT)
if (outPath.startsWith(process.cwd())) {
  throw new Error(
    `Refusing to write a session file inside the repo: ${outPath}\n` +
      'This repository is public. Choose a path outside it.'
  )
}

/** Signed in once we are off every /auth/* screen and on the app. */
const isSignedIn = (url: string) => {
  try {
    const u = new URL(url)
    return u.origin === new URL(BASE_URL).origin && u.pathname.startsWith('/app')
  } catch {
    return false
  }
}

async function listProjects(context: BrowserContext) {
  const page = await context.newPage()
  try {
    const res = await page.request.get(`${BASE_URL}/api/projects`)
    if (!res.ok()) return null
    const body: any = await res.json()
    const rows = Array.isArray(body) ? body : (body.projects ?? body.data ?? [])
    return rows.map((r: any) => ({ id: r.id, name: r.name })).filter((r: any) => r.id)
  } catch {
    return null
  } finally {
    await page.close()
  }
}

async function main() {
  mkdirSync(dirname(outPath), { recursive: true })

  // Prefer real Chrome; fall back to bundled Chromium if it is not installed.
  let context: BrowserContext
  try {
    const browser = await chromium.launch({ headless: false, channel: 'chrome' })
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  } catch {
    console.log('Real Chrome not found, falling back to bundled Chromium.')
    console.log('If Google blocks sign-in, install Chrome or use the FALLBACK below.\n')
    const browser = await chromium.launch({ headless: false })
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  }

  const page = await context.newPage()
  await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded' })

  console.log('\n' + '='.repeat(64))
  console.log('  A browser window just opened.')
  console.log('  Sign in there with Google or GitHub, exactly as you normally do.')
  console.log('  Do not close the window. This will continue on its own.')
  console.log('  Waiting up to 5 minutes...')
  console.log('='.repeat(64) + '\n')

  const deadline = Date.now() + 5 * 60_000
  while (Date.now() < deadline) {
    if (isSignedIn(page.url())) break
    await page.waitForTimeout(1000)
  }

  if (!isSignedIn(page.url())) {
    throw new Error(`Timed out waiting for sign-in. Last URL: ${page.url()}`)
  }

  // Confirm the session actually works rather than trusting the URL. A state
  // captured from a half-finished login looks identical on disk and only fails
  // later, mid-shoot.
  await page.goto(`${BASE_URL}/app`, { waitUntil: 'domcontentloaded' })
  if (!isSignedIn(page.url())) throw new Error('Signed-in check failed: /app bounced away.')

  await context.storageState({ path: outPath })
  console.log(`\nSession saved to ${outPath}`)

  const projects = await listProjects(context)
  if (projects?.length) {
    console.log('\nYour projects:\n')
    for (const p of projects) console.log(`  ${p.name.padEnd(28)} ${p.id}`)
    const field = projects.find((p: any) => /fieldnote/i.test(p.name))
    if (field) {
      console.log(`\nFieldnote project id:\n\n  BACKENLY_PROJECT_ID=${field.id}\n`)
    } else {
      console.log('\nNo project named "Fieldnote" found. Pick the right id from the list above.')
    }
  } else {
    console.log('\nCould not list projects automatically. Open the project and copy the id from the URL.')
  }

  console.log('Treat the session file as a credential. Delete it when the shoot is done.')
  await context.close()
}

main().catch((err) => {
  console.error('\n' + err.message)
  console.error(
    '\nFALLBACK if Google refused to sign in inside the automated browser:\n' +
      '  1. Sign in to backenly.com in your normal Chrome.\n' +
      '  2. Open DevTools (F12) > Application > Cookies > https://backenly.com\n' +
      '  3. Tell me, and I will walk you through exporting them into a state file.\n'
  )
  process.exit(1)
})
