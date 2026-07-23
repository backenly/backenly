import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
// Must track next.config.js's distDir. A deploy builds into a staging dir
// (NEXT_DIST_DIR) and renames it into place afterwards; if this script kept
// writing to a hardcoded .next it would copy the new build's static assets
// on top of the LIVE tree — reintroducing exactly the mid-build corruption
// the staging build exists to prevent.
const distDir = process.env.NEXT_DIST_DIR || '.next'
const standaloneRoot = join(root, distDir, 'standalone')

// distDir applies INSIDE standalone as well. Next mirrors the dist directory
// into the standalone tree under the same name and freezes it into server.js
// as `"distDir":"./<distDir>"`, so a staging build produces
// standalone/.next.staging/ and the runtime reads static from
// standalone/.next.staging/static — NOT standalone/.next/static.
//
// This line used to be hardcoded to '.next'. With NEXT_DIST_DIR set, every
// static asset landed in a directory the server never reads: the deploy went
// green, health-checked OK (the HTML renders fine), and then every JS chunk
// and stylesheet 404'd for real users, taking backenly.com down until it was
// diagnosed by hand (2026-07-21).
const standaloneNext = join(standaloneRoot, distDir)

mkdirSync(standaloneNext, { recursive: true })

const copies = [
  // public/ is NOT dist-scoped — Next always serves it from the standalone root.
  [join(root, distDir, 'static'), join(standaloneNext, 'static')],
  [join(root, 'public'), join(standaloneRoot, 'public')],
]

for (const [from, to] of copies) {
  if (!existsSync(from)) {
    console.warn(`[postbuild] Skipped missing path: ${from}`)
    continue
  }

  rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true })
  console.log(`[postbuild] Copied ${from} -> ${to}`)
}

// Verify against the runtime's own baked config rather than trusting that the
// two paths above were derived correctly. The failure this guards against is
// silent by nature: the server starts, the HTML renders, health checks pass,
// and only the browser discovers the assets are missing.
const serverEntry = join(standaloneRoot, 'server.js')
if (!existsSync(serverEntry)) {
  console.error(`[postbuild] FAILED: ${serverEntry} missing — build did not produce a standalone server.`)
  process.exit(1)
}

const baked = readFileSync(serverEntry, 'utf8').match(/"distDir":"([^"]+)"/)?.[1]
if (!baked) {
  console.warn('[postbuild] Could not read distDir from server.js — skipping placement check.')
} else {
  // Baked form is "./<distDir>"; compare on the bare name.
  const bakedName = baked.replace(/^\.\//, '')
  const servedChunks = join(standaloneRoot, bakedName, 'static', 'chunks')

  if (bakedName !== distDir) {
    console.error(
      `[postbuild] FAILED: server.js serves static from "${bakedName}" but assets were copied to "${distDir}". ` +
        `Every chunk would 404 at runtime.`
    )
    process.exit(1)
  }

  if (!existsSync(servedChunks) || readdirSync(servedChunks).length === 0) {
    console.error(`[postbuild] FAILED: no chunks at ${servedChunks} — the runtime would serve a broken page.`)
    process.exit(1)
  }

  console.log(`[postbuild] Verified ${readdirSync(servedChunks).length} chunks at ${servedChunks}`)
}
