/**
 * Pre-extract only the Iconify icons used by the marketing site into
 * lib/icons/data.json. Run after editing the SOLAR / RI arrays below.
 *
 *   node scripts/extract-icons.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const SOLAR = [
  'box-minimalistic-linear',
  'arrow-right-up-linear',
  'cpu-bolt-linear',
  'radar-linear',
  'check-circle-linear',
  'database-linear',
  'key-linear',
  'bolt-circle-linear',
  'folder-with-files-linear',
  'code-circle-linear',
  'plug-circle-linear',
  'copy-linear',
  'earth-bold-duotone',
  'shield-warning-linear',
  'document-medicine-linear',
  'user-bold-duotone',
  'magic-stick-3-bold-duotone',
  'users-group-two-rounded-bold-duotone',
  'magnifer-linear',
  'history-linear',
  'users-group-two-rounded-linear',
  'global-linear',
  'bell-linear',
  'shield-keyhole-linear',
  'document-text-linear',
  'rocket-2-linear',
  'add-circle-linear',
  'hamburger-menu-linear',
  'close-circle-linear',
  'alt-arrow-down-linear',
  'user-rounded-linear',
  'letter-linear',
  'check-square-linear',
  // Connect Frontend + Autonomy section rewrite
  'qr-code-linear',
  'shield-check-linear',
  'tuning-2-linear',
  'rewind-back-circle-linear',
  'lock-keyhole-minimalistic-linear',
]
const RI = [
  'twitter-x-line',
  'linkedin-fill',
  'reactjs-line',
  'nextjs-line',
  'vuejs-line',
  'svelte-fill',
  'smartphone-line',
  'eye-line',
  'eye-off-line',
  'github-fill',
]
// Real brand marks for the Connect Frontend chips (framework + AI builders).
const SI = [
  'react',
  'nextdotjs',
  'svelte',
  'vuedotjs',
  'expo',
  'replit',
  'cursor',
  'v0',
  'claude',
]

function loadCollection(pkg) {
  const file = path.join(root, 'node_modules', pkg, 'icons.json')
  return JSON.parse(fs.readFileSync(file, 'utf-8'))
}

function subset(coll, wanted) {
  const icons = {}
  for (const name of wanted) {
    if (coll.icons[name]) icons[name] = coll.icons[name]
    else console.warn(`  ! missing ${coll.prefix}:${name}`)
  }
  return { prefix: coll.prefix, icons, width: coll.width, height: coll.height }
}

const solar = loadCollection('@iconify-json/solar')
const ri = loadCollection('@iconify-json/ri')
const si = loadCollection('@iconify-json/simple-icons')

const out = {
  solar: subset(solar, SOLAR),
  ri: subset(ri, RI),
  si: subset(si, SI),
}
const target = path.join(root, 'lib/icons/data.json')
fs.writeFileSync(target, JSON.stringify(out))

const size = fs.statSync(target).size
console.log(
  `Wrote ${target} — ${(size / 1024).toFixed(1)} KB, ${SOLAR.length + RI.length + SI.length} icons`,
)
