#!/usr/bin/env tsx
/**
 * Would this checkout start, as the edition it claims to be?
 *
 * The servers make this exact check at startup (lib/edition/cloud-extension.ts,
 * called from instrumentation.ts and server/index.ts). Running it here means a
 * composed Cloud tree can be proven good on the deploy host or in CI, rather
 * than discovering the answer as a PM2 crash loop.
 *
 * It is the "does the Cloud provider load" gate for backenly-cloud's CI, which
 * composes a public checkout with the private overlay and then asks this.
 *
 * Usage:
 *   tsx scripts/verify-cloud-composition.ts
 *   tsx scripts/verify-cloud-composition.ts --expect present
 *   tsx scripts/verify-cloud-composition.ts --expect absent
 *
 * Exit 0 when the process would start, 1 when it would refuse. With --expect,
 * exit 0 only when the composition state is exactly the one named, so a test
 * cannot pass by reaching the right verdict for the wrong reason.
 */
import {
  assertEditionComposition,
  currentEditionLabel,
  loadCloudExtension,
  requiresCloudComposition,
} from '../lib/edition/cloud-extension'

const argv = process.argv.slice(2)
const expectIdx = argv.indexOf('--expect')
const expected = expectIdx >= 0 ? argv[expectIdx + 1] : null

const VALID_EXPECTATIONS = ['present', 'absent', 'invalid']
if (expectIdx >= 0 && (!expected || !VALID_EXPECTATIONS.includes(expected))) {
  console.error(`--expect must be one of ${VALID_EXPECTATIONS.join(', ')}`)
  process.exit(2)
}

const state = loadCloudExtension()

console.log(`edition:      ${currentEditionLabel()}`)
console.log(`composition:  ${state.status}`)
if (state.status === 'present') {
  console.log(`base sha:     ${state.manifest.publicBaseSha}`)
  console.log(`capabilities: ${state.manifest.capabilities.join(', ') || '(none)'}`)
} else if (state.status === 'invalid') {
  console.log(`reason:       ${state.reason}`)
}
console.log(`required:     ${requiresCloudComposition()}`)

let failed = false

if (expected && state.status !== expected) {
  console.error(`\nFAIL: expected composition state "${expected}", got "${state.status}"`)
  failed = true
}

try {
  assertEditionComposition()
  console.log('\nthis checkout would start')
} catch (err) {
  console.error(`\nthis checkout would REFUSE to start:\n${(err as Error).message}`)
  failed = true
}

process.exit(failed ? 1 : 0)
