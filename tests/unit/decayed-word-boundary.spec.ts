/**
 * THE DECAYED WORD BOUNDARY
 * =========================
 *
 * `\b` is a word boundary in a regular expression literal. In a string or
 * template literal — and after any editing step that collapses one backslash
 * into none — it is U+0008, BACKSPACE. The regex then requires a control
 * character that no real input contains, so it matches nothing.
 *
 * That failure is silent and it is always oriented the same way: the check
 * reports the safe answer. A redactor redacts nothing and reports a clean
 * message. A posture verifier finds no violation and reports a clean repo. A
 * reader detector finds no reference and reports a reader that reads nothing.
 * Three of these shipped in this repository, each one a check that had stopped
 * measuring while continuing to pass.
 *
 * Terminals make it worse: U+0008 erases the character before it on screen, so
 * the broken form renders as the correct form in a diff, a log, or a file
 * viewer. It cannot be caught by reading. It has to be caught by byte.
 *
 * So this suite asserts the byte is absent from tracked source, and separately
 * asserts that the two regexes that decayed actually do their jobs now.
 */
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'

import { sanitizeError } from '@/lib/services/workspace-backup'

const ROOT = join(__dirname, '..', '..')
// Built by code point, never written as an escape. An escape for this
// character is exactly what decays into the character, and a guard that
// contained the byte it searches for would flag itself - which it did.
const BACKSPACE = String.fromCharCode(8)

function trackedSourceFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.sql', '*.sh'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return out.split('\0').filter(Boolean)
}

describe('no decayed word boundaries in tracked source', () => {
  it('finds U+0008 in no tracked source file', () => {
    const files = trackedSourceFiles()
    // Guard against the check silently measuring nothing, which is the very
    // failure mode it exists to catch.
    expect(files.length).toBeGreaterThan(100)

    const offenders: string[] = []
    for (const rel of files) {
      let text: string
      try {
        text = readFileSync(join(ROOT, rel), 'latin1')
      } catch {
        continue
      }
      if (!text.includes(BACKSPACE)) continue
      const line = text.slice(0, text.indexOf(BACKSPACE)).split('\n').length
      offenders.push(`${rel}:${line}`)
    }

    expect(offenders).toEqual([])
  })
})

// The passwords here stay arbitrary on purpose: that is what these assertions
// prove sanitizeError handles. The HOSTS are deliberately localhost, because
// scripts/preflight-oss.ts treats a DSN pointed at a local host as benign and
// only recognises the host when a port or path delimiter follows it, which is
// why each of these carries an explicit :5432, and
// flags one pointed anywhere else. A redaction test containing a
// routable-looking DSN made that gate the only red job on main, and the gate's
// own header is right that every false positive spends its credibility.
describe('sanitizeError actually redacts', () => {
  it('masks the password in a connection string', () => {
    const out = sanitizeError('failed: postgres://backenly_user:s3cr3t-p4ssw0rd@localhost:5432/backenly')
    expect(out).not.toContain('s3cr3t-p4ssw0rd')
    expect(out).toContain('postgres://backenly_user:***@')
  })

  it('masks every scheme and every occurrence', () => {
    const out = sanitizeError(
      'primary postgresql://a:one-secret@localhost:5432/db1 and replica postgres://b:two-secret@localhost:5432/db2',
    )
    expect(out).not.toContain('one-secret')
    expect(out).not.toContain('two-secret')
  })

  it('masks a connection string embedded mid-token', () => {
    // The boundary anchors the scheme; it must not become an excuse to miss a
    // URL that is quoted, parenthesised, or glued to preceding text.
    const out = sanitizeError('DATABASE_URL="postgres://u:hunter2-hunter2@localhost:5432/db"')
    expect(out).not.toContain('hunter2-hunter2')
  })

  it('leaves a message with no credential alone', () => {
    const msg = 'pg_dump: error: connection to server at "db.internal" failed'
    expect(sanitizeError(msg)).toBe(msg)
  })
})
