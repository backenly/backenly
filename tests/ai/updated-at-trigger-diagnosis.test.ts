/**
 * REGRESSION: updatedAt-trigger 42703 → "Column does not exist" diagnosis
 * ======================================================================
 * A BEFORE UPDATE trigger whose body is `NEW."updatedAt" = NOW()` raises the
 * PL/pgSQL error `record "new" has no field "updatedAt"` (SQLSTATE 42703) when
 * it fires on a table that lacks a camelCase `updatedAt` field. Unlike a plain
 * `column "x" does not exist`, this phrasing carries NO extractable column or
 * table name — so the sanitizer renders the exact generic string a user saw in
 * the CRUD-lifecycle verification card. This test locks that chain so the
 * behavioral-check-to-fixes mapper can key off it deterministically.
 */

import { sanitizeDiagnostic } from '../../lib/errors/diagnostic-sanitize'

describe('sanitizeDiagnostic — updatedAt trigger error', () => {
  it('renders `record "new" has no field "updatedAt"` as the generic column message (no column extracted)', () => {
    const raw =
      'Invalid `prisma.$queryRawUnsafe()` invocation:\n' +
      'Raw query failed. Code: `42703`. Message: `record "new" has no field "updatedAt"`'
    const out = sanitizeDiagnostic(raw)
    expect(out).toBe('Column does not exist — the referenced column is missing from the table.')
    // Crucially: it must NOT name a column, because the trigger phrasing has none.
    expect(out).not.toMatch(/`/)
  })

  it('a plain missing-column error DOES surface the column name (contrast)', () => {
    const raw = 'Raw query failed. Code: `42703`. Message: `column "user_id" does not exist`'
    const out = sanitizeDiagnostic(raw)
    expect(out).toContain('user_id')
  })
})
