/**
 * Hosted SDK bundle builder.
 *
 * packages/sdk/src is the single source of truth for the client SDK. The two
 * hosted files under public/ used to be maintained BY HAND and drifted from
 * the real SDK (missing realtime, stale auth flows). This script generates
 * both from source so they cannot drift again:
 *
 *   public/backenly-sdk.js      — IIFE/UMD-style, <script src=…> consumers
 *                                 (globals: Backenly, createClient,
 *                                  createClient)
 *   public/backenly-sdk.esm.js  — ESM, `import { createClient } from …`
 *
 * Runs as part of `npm run build` (see package.json) so every deploy ships
 * bundles built from the same commit as the runtime.
 */

import { build } from 'esbuild'
import { fileURLToPath } from 'url'
import path from 'path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = path.join(ROOT, 'packages', 'sdk', 'src', 'index.ts')
const ENTRY_SUPABASE = path.join(ROOT, 'packages', 'sdk', 'src', 'supabase-compat.ts')
const OUT_UMD = path.join(ROOT, 'public', 'backenly-sdk.js')
const OUT_ESM = path.join(ROOT, 'public', 'backenly-sdk.esm.js')
const OUT_SUPABASE = path.join(ROOT, 'public', 'backenly-supabase.esm.js')

const BANNER_SUPABASE = `/**
 * Backenly ↔ supabase-js compatibility shim (generated — DO NOT EDIT BY HAND)
 * Hosted at: https://backenly.com/backenly-supabase.esm.js
 *
 * Migrate a supabase-js frontend to Backenly by swapping two strings:
 *   import { createClient } from "https://backenly.com/backenly-supabase.esm.js"
 *   const supabase = createClient("https://backenly.com/api/v1/<PROJECT_ID>", "<BACKENLY_ANON_KEY>")
 * Everything else — .from().select().eq(), auth.signInWithPassword, channels —
 * keeps working. { data, error } contract preserved; nothing throws.
 */`

const BANNER = `/**
 * Backenly Client SDK (generated from packages/sdk — DO NOT EDIT BY HAND)
 * Hosted at: https://backenly.com/backenly-sdk.js (UMD)
 *            https://backenly.com/backenly-sdk.esm.js (ESM)
 *
 * Usage (plain HTML / Replit):
 *   <script src="https://backenly.com/backenly-sdk.js"></script>
 *   <script>
 *     const backend = createClient({ projectId: "your-id", apiKey: "your-key" })
 *     const posts = await backend.posts.list()
 *   </script>
 *
 * Usage (React / Next.js / Vue / bundlers — Base44, Lovable, Cursor, v0):
 *   import { createClient } from "https://backenly.com/backenly-sdk.esm.js"
 *   const backend = createClient({ projectId: "your-id", apiKey: "your-key" })
 */`

// Back-compat globals + CommonJS escape hatch for the script-tag bundle.
// esbuild's IIFE emits `var Backenly = (() => {…})()`; this footer mirrors the
// old hand-written UMD surface exactly.
const UMD_FOOTER = `
;(function (g) {
  if (!g) return
  g.Backenly = Backenly
  g.createClient = Backenly.createClient
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : undefined)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Backenly
  module.exports.default = Backenly
}
`

const shared = {
  entryPoints: [ENTRY],
  bundle: true,
  platform: 'browser',
  target: ['es2019'],
  // Keep the bundle readable/diffable — it is served with gzip anyway and the
  // debuggability matters more than the bytes at this stage.
  minify: false,
  legalComments: 'none',
  logLevel: 'silent',
}

async function main() {
  await build({
    ...shared,
    format: 'iife',
    globalName: 'Backenly',
    outfile: OUT_UMD,
    banner: { js: BANNER },
    footer: { js: UMD_FOOTER },
  })

  await build({
    ...shared,
    format: 'esm',
    outfile: OUT_ESM,
    banner: { js: BANNER },
  })

  await build({
    ...shared,
    entryPoints: [ENTRY_SUPABASE],
    format: 'esm',
    outfile: OUT_SUPABASE,
    banner: { js: BANNER_SUPABASE },
  })

  console.log('✔ SDK bundles generated from packages/sdk/src:')
  console.log(`   ${path.relative(ROOT, OUT_UMD)}`)
  console.log(`   ${path.relative(ROOT, OUT_ESM)}`)
  console.log(`   ${path.relative(ROOT, OUT_SUPABASE)}`)
}

main().catch((err) => {
  console.error('✖ SDK bundle build failed:', err?.message ?? err)
  process.exit(1)
})
