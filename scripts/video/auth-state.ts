/**
 * ONE-TIME LOGIN -> PLAYWRIGHT storageState
 * =========================================
 *
 * Logs in once and writes a session file the recorder reuses, so no password is
 * ever present while the camera is rolling and no credential is ever typed on
 * screen.
 *
 * Write the output OUTSIDE this repository. It is a live session; committing it
 * would be committing a credential to a public repo.
 *
 * Usage:
 *   BACKENLY_BASE_URL=https://backenly.com \
 *   BACKENLY_EMAIL=... BACKENLY_PASSWORD=... \
 *   BACKENLY_STORAGE_STATE=/abs/path/outside/repo/state.json \
 *   npx tsx scripts/video/auth-state.ts
 */

import { chromium } from '@playwright/test'
import { resolve, dirname } from 'path'
import { mkdirSync } from 'fs'

const BASE_URL = process.env.BACKENLY_BASE_URL ?? 'https://backenly.com'
const EMAIL = process.env.BACKENLY_EMAIL
const PASSWORD = process.env.BACKENLY_PASSWORD
const OUT = process.env.BACKENLY_STORAGE_STATE

if (!EMAIL || !PASSWORD) throw new Error('BACKENLY_EMAIL and BACKENLY_PASSWORD are required')
if (!OUT) throw new Error('BACKENLY_STORAGE_STATE (absolute output path) is required')

const outPath = resolve(OUT)
if (outPath.includes(`${process.cwd()}`)) {
  throw new Error(
    `Refusing to write a session file inside the repo: ${outPath}\n` +
      'This repository is public. Choose a path outside it.'
  )
}

async function main() {
  mkdirSync(dirname(outPath), { recursive: true })

  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
  const page = await context.newPage()

  await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('#email', EMAIL!)
  await page.fill('#password', PASSWORD!)
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/auth/login'), { timeout: 45_000 }),
    page.click('button[type="submit"]'),
  ])

  // Prove the session is real before persisting it. A storageState captured from
  // a failed login looks identical on disk and only fails later, mid-shoot.
  await page.goto(`${BASE_URL}/app`, { waitUntil: 'domcontentloaded' })
  if (page.url().includes('/auth/login')) {
    throw new Error('Login did not stick — /app bounced back to the login page.')
  }

  await context.storageState({ path: outPath })
  await browser.close()

  console.log(`Session saved to ${outPath}`)
  console.log('Treat this file as a credential. Delete it when the shoot is done.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
