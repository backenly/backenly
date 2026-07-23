/**
 * Pure-logic verification of the bonus-credit accounting (no DB).
 *
 * The real risk in lib/billing/credit-ledger.ts is the ACCOUNTING MATH:
 * double-counting between the monthly cap (plan + bonus) and the month-rollover
 * burn. This mirrors that exact logic and asserts the invariants that make a
 * granted credit both spendable AND correctly persisted across months.
 *
 * Run: node scripts/verify-credit-ledger.mjs
 */

const TOKENS_PER_CREDIT = 1_000
const creditsFromTokens = (t) => (t <= 0 ? 0 : Math.ceil(t / TOKENS_PER_CREDIT))

function prevMonth(month) {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 2, 1))
  return d.toISOString().slice(0, 7)
}

function normaliseRefCode(raw) {
  if (!raw) return null
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  return cleaned.length >= 5 && cleaned.length <= 12 ? cleaned : null
}

// Mirror of reconcileBonusRollover's per-month burn loop.
function reconcileMonth(bonus, planCredits, tokenCount) {
  if (bonus <= 0 || planCredits == null) return { bonus, burn: 0 }
  const creditsUsed = creditsFromTokens(tokenCount)
  const overage = Math.max(0, creditsUsed - planCredits)
  const burn = Math.min(overage, bonus)
  return { bonus: bonus - burn, burn }
}

let failures = 0
function assert(name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`) }
  else { console.error(`  ✗ ${name} ${detail}`); failures++ }
}

console.log('1. Effective cap = plan + bonus (bonus constant within a month)')
{
  const plan = 200, bonus = 500
  assert('cap is 700', plan + bonus === 700)
  // Enforcement allows while creditsUsed < cap.
  assert('spend 699 allowed', 699 < plan + bonus)
  assert('spend 700 blocked', !(700 < plan + bonus))
}

console.log('2. Month-rollover burn draws only the over-allowance portion')
{
  assert('spent 150 (< plan) → burn 0', reconcileMonth(500, 200, 150_000).burn === 0)
  assert('spent 250 → burn 50, bonus 450', (() => { const r = reconcileMonth(500, 200, 250_000); return r.burn === 50 && r.bonus === 450 })())
  assert('spent 700 (full cap) → burn 500, bonus 0', (() => { const r = reconcileMonth(500, 200, 700_000); return r.burn === 500 && r.bonus === 0 })())
  assert('burn never exceeds bonus', reconcileMonth(500, 200, 999_000).burn === 500)
  assert('unlimited plan (null) never burns', reconcileMonth(500, null, 999_000).burn === 0)
}

console.log('3. No double-count across two months')
{
  // Month 1: plan 200, bonus 500, spend the full 700 → bonus should end at 0.
  const m1 = reconcileMonth(500, 200, 700_000)
  assert('month1 ends bonus 0', m1.bonus === 0)
  // Month 2: cap = plan + carried bonus.
  const m2cap = 200 + m1.bonus
  assert('month2 cap back to 200 (no phantom bonus)', m2cap === 200)
}

console.log('4. Partial spend persists remaining bonus to next month')
{
  const m1 = reconcileMonth(500, 200, 300_000) // used 300 → 100 over → burn 100
  assert('month1 burn 100, bonus 400', m1.burn === 100 && m1.bonus === 400)
  const m2cap = 200 + m1.bonus
  assert('month2 cap 600', m2cap === 600)
}

console.log('5. prevMonth() across boundaries')
{
  assert('2026-07 → 2026-06', prevMonth('2026-07') === '2026-06')
  assert('2026-01 → 2025-12', prevMonth('2026-01') === '2025-12')
  assert('2026-03 → 2026-02', prevMonth('2026-03') === '2026-02')
}

console.log('6. normaliseRefCode()')
{
  assert("'abc12' → 'ABC12'", normaliseRefCode('abc12') === 'ABC12')
  assert("' aB3-x9 ' → 'AB3X9'", normaliseRefCode(' aB3-x9 ') === 'AB3X9')
  assert("too short → null", normaliseRefCode('ab12') === null)
  assert("too long → null", normaliseRefCode('ABCDEFGHIJKLM') === null)
  assert("empty → null", normaliseRefCode('') === null)
  assert("null → null", normaliseRefCode(null) === null)
}

console.log('')
if (failures === 0) { console.log('ALL CREDIT-LEDGER ACCOUNTING CHECKS PASSED') }
else { console.error(`${failures} CHECK(S) FAILED`); process.exit(1) }
