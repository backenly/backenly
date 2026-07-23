/**
 * Unit check for the destructive-confirm matcher — run with:
 *   npx tsx scripts/test-destructive-confirm-matcher.ts
 * Exercises the exact phrases observed in the 2026-07-16 live test where the
 * chat door looped on confirmation.
 */
import { isDestructiveConfirmation, type PendingDestructive } from '../lib/ai/brain/pending-destructive'

const pending: PendingDestructive = {
  calls: [{ tool: 'drop_table', args: { tableName: 'junk_test' }, target: 'the `junk_test` table' }],
  originalMessage: 'Drop the junk_test table.',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
}

const cases: Array<[string, boolean]> = [
  ['Drop the junk_test table.', true], // re-stating the imperative (the observed loop)
  ['drop junk_test', true], // the phrase the model invented and the old gate rejected
  ['yes', true],
  ['confirm', true],
  ['Confirm — drop the junk_test table', true], // danger card button
  ['ok', true],
  ['do it', true],
  ['proceed', true],
  ['what tables do I have?', false], // moved on
  ['drop the followers table', false], // different target
  ['add a posts table', false],
  ['no, keep it', false],
  ['', false],
]

// Replay mode — the model prose-asked without attempting the tool, so no
// concrete calls were stored; matching falls back to the original message.
// This is the exact 2026-07-16 "delete followers table" shape.
const replayPending: PendingDestructive = {
  calls: [],
  originalMessage: 'delete followers table',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
}

const replayCases: Array<[string, boolean]> = [
  ['confirm', true], // the exact phrase the model instructed on 2026-07-16
  ['yes', true],
  ['Confirm — drop the followers table', true],
  ['delete followers table', true], // re-stated imperative
  ['drop followers', true],
  ['drop the junk_test table', false], // different target
  ['show me my tables', false],
]

let failures = 0
for (const [msg, want] of cases) {
  const got = isDestructiveConfirmation(msg, pending)
  if (got !== want) {
    failures++
    console.log(`FAIL: ${JSON.stringify(msg)} got=${got} want=${want}`)
  } else {
    console.log(`ok  : ${JSON.stringify(msg)} -> ${got}`)
  }
}
for (const [msg, want] of replayCases) {
  const got = isDestructiveConfirmation(msg, replayPending)
  if (got !== want) {
    failures++
    console.log(`FAIL (replay): ${JSON.stringify(msg)} got=${got} want=${want}`)
  } else {
    console.log(`ok (replay): ${JSON.stringify(msg)} -> ${got}`)
  }
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
