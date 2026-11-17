import crypto from 'crypto'

/**
 * The evidence a finding carries, as one hash: the detector's output without
 * the fields later passes add to it (a diagnosis, investigation bookkeeping, an
 * unverified-change record). A diagnosis or a proposal is kept while it
 * matches; new evidence makes both stale.
 */
export function evidenceFingerprint(type: string, details: Record<string, unknown>): string {
  const evidence = { ...details }
  for (const key of ['diagnosis', 'investigation', 'appliedUnverified', 'rollbackData', 'proposal']) delete evidence[key]
  const stable = JSON.stringify(evidence, Object.keys(evidence).sort())
  return crypto.createHash('sha256').update(`${type}\n${stable}`).digest('hex').slice(0, 32)
}

/**
 * The diagnosis a finding carries, only while it was made from the evidence
 * the finding carries now; undefined otherwise.
 *
 * A diagnosis is written onto the row it investigated, with the fingerprint of
 * the evidence it read. When that row's evidence changes, or another gap's
 * evidence is written over it (production QA, 2026-11-16: an orders card
 * carried the explanation written about reviews.user_id), it explains something
 * the row no longer says. The investigator treats it as stale and looks again
 * (escalation-diagnosis.ts, isDue); until then it is not served. One written
 * before diagnoses carried a fingerprint counts as current, as it does there.
 */
export function currentDiagnosis(type: string, details: Record<string, unknown> | null | undefined): unknown {
  const d = details ?? {}
  const diagnosis = d.diagnosis
  if (!diagnosis || typeof diagnosis !== 'object' || Array.isArray(diagnosis)) return undefined
  const fingerprint = (diagnosis as { fingerprint?: unknown }).fingerprint
  if (typeof fingerprint !== 'string') return diagnosis
  return fingerprint === evidenceFingerprint(type, d) ? diagnosis : undefined
}

/** A finding's details as they are served: without a diagnosis made from other evidence. */
export function withoutStaleDiagnosis<T extends Record<string, unknown>>(type: string, details: T): T {
  if (!('diagnosis' in details) || currentDiagnosis(type, details) !== undefined) return details
  const { diagnosis: _stale, ...rest } = details
  return rest as T
}
