/**
 * Editing a .env in place, without destroying it.
 *
 * Extracted from the self-host installer so it can be tested directly. The
 * logic here is short but it is the part most able to do real damage: it writes
 * to the file holding every secret a deployment has, and it runs on a machine
 * where the operator may already have configured things by hand.
 *
 * Two properties matter, and both are asserted in
 * __tests__/selfhost/env-file.test.ts:
 *
 *   1. It NEVER overwrites a real value. Rerunning an installer is normal, and
 *      regenerating JWT_SECRET on a rerun would sign out every session while
 *      regenerating the authenticator password would break a running PostgREST.
 *
 *   2. It DOES overwrite a template placeholder. `.env.example` ships
 *      JWT_SECRET=your-super-secret-jwt-key-change-this-in-production, which is
 *      a string in a public repository. Treating that as "already configured"
 *      is how a deployment ends up signing sessions with a key everybody has,
 *      so a placeholder has to count as absent.
 *
 * Lines are kept as lines rather than parsed into a map and re-serialised. The
 * template's comments are the only documentation many of these keys have, and
 * round-tripping through a map deletes all of them.
 */

/** Matches `KEY=`, tolerating leading whitespace. Not commented-out lines. */
function assignmentPattern(key: string): RegExp {
  return new RegExp(`^\\s*${escapeForRegExp(key)}\\s*=`)
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.fromCharCode(92) + '$&')
}

/**
 * The current value of a key, or null when the key is absent entirely.
 *
 * A commented-out line reads as absent, which is correct: `# JWT_SECRET=x` does
 * not configure anything.
 */
export function envValue(lines: readonly string[], key: string): string | null {
  const pattern = new RegExp(`^\\s*${escapeForRegExp(key)}\\s*=(.*)$`)
  for (const line of lines) {
    const m = line.match(pattern)
    if (m) return m[1].trim()
  }
  return null
}

/**
 * Whether a value is one of the template's own placeholders rather than a
 * configured secret.
 *
 * Deliberately conservative in one direction only. A false positive would
 * overwrite a real secret, so the patterns match shapes that no generated
 * credential has: the literal `change-this` and `your-` markers the template
 * uses, an angle-bracket placeholder, or nothing at all.
 */
export function isPlaceholder(value: string): boolean {
  if (value === '') return true
  if (/change-this/i.test(value)) return true
  if (/^your-/i.test(value)) return true
  if (/^<.*>$/.test(value)) return true
  return false
}

export type EnsureOutcome = 'kept' | 'generated'

/**
 * Fill a key only when it is absent or still a placeholder.
 *
 * Mutates `lines` in place and returns what it did, so a caller can report
 * which secrets it generated without diffing the file.
 */
export function ensureEnvVar(
  lines: string[],
  key: string,
  generate: () => string
): EnsureOutcome {
  const current = envValue(lines, key)
  if (current !== null && !isPlaceholder(current)) return 'kept'

  const value = generate()
  const idx = lines.findIndex(l => assignmentPattern(key).test(l))
  if (idx >= 0) lines[idx] = `${key}=${value}`
  else lines.push(`${key}=${value}`)
  return 'generated'
}

/**
 * Set a key to an exact value, whether or not it already had one.
 *
 * Separate from ensureEnvVar because the intent is different and the danger is
 * different. This is for a value the caller has just been handed and must
 * record — the authenticator password, which PostgREST is about to
 * authenticate with. Callers decide when overwriting is right; the file editor
 * does not guess.
 */
export function setEnvVar(lines: string[], key: string, value: string): void {
  const idx = lines.findIndex(l => assignmentPattern(key).test(l))
  if (idx >= 0) lines[idx] = `${key}=${value}`
  else lines.push(`${key}=${value}`)
}
