/**
 * The operator blocklist: exact ip / email / domain values somebody added.
 *
 * PUBLIC, and deliberately NOT filed with the Cloud abuse intelligence. A
 * blocklist entry is an explicit decision a human made about their own
 * deployment, which is the same category as a kill switch, and the signup path
 * already treats it that way: the comment in assertSignupAllowed says the
 * blocklist runs BEFORE the heuristics precisely because "a hand-added entry is
 * an explicit decision and should never be second-guessed by a score", and the
 * self-host first-operator branch keeps applying it while skipping the scoring.
 *
 * Moving it private would have silently removed blocklist enforcement from
 * self-hosted login and signup. Scoring a stranger is Cloud's; honouring a list
 * the operator wrote is the product's.
 *
 * The admin console that EDITS the list is Backenly's and moves with the back
 * office; only the lookup lives here.
 */
import { prisma } from '@/lib/db/prisma'

// ─── Blocklist ────────────────────────────────────────────────────────────────

interface BlocklistMatch { kind: 'ip' | 'email' | 'domain'; value: string }

// Tiny cache so login/signup don't hammer the DB.
let _blockCache: { rows: { kind: string; value: string }[]; expiresAt: number } | null = null
const BLOCKLIST_TTL_MS = 10_000

async function loadBlocklist(): Promise<{ kind: string; value: string }[]> {
  const now = Date.now()
  if (_blockCache && _blockCache.expiresAt > now) return _blockCache.rows
  try {
    const rows = await prisma.blocklist.findMany({ select: { kind: true, value: true } })
    _blockCache = { rows, expiresAt: now + BLOCKLIST_TTL_MS }
    return rows
  } catch {
    return _blockCache?.rows ?? []
  }
}

export function invalidateBlocklistCache() {
  _blockCache = null
}

export async function isBlocked(
  input: { email?: string | null; ip?: string | null },
): Promise<BlocklistMatch | null> {
  const rows = await loadBlocklist()
  if (rows.length === 0) return null
  const email = input.email?.toLowerCase().trim() ?? ''
  const domain = email.includes('@') ? email.split('@')[1] : ''
  const ip = input.ip?.trim() ?? ''
  for (const r of rows) {
    const v = r.value.toLowerCase()
    if (r.kind === 'email' && email && v === email) return { kind: 'email', value: v }
    if (r.kind === 'domain' && domain && (v === domain || domain.endsWith(`.${v}`))) return { kind: 'domain', value: v }
    if (r.kind === 'ip' && ip && v === ip) return { kind: 'ip', value: v }
  }
  return null
}
