/**
 * Proves the intent-conformance detector can FIRE.
 *
 * The rule this suite exists to enforce: a probe that has never been observed
 * producing a finding is presumed broken, not healthy. `detectMissingRls` sat
 * silently dead in every environment — duplicate bind parameter, swallowed
 * error — while the dashboard rendered green, and nothing ever asserted it
 * could fail. Every check below therefore has a paired negative case.
 *
 * The headline case is the real one: `{ name: 'start_date', type: 'timestamp' }`
 * built as INTEGER, which survived from May to July with every probe green
 * because nothing recorded what had been asked for.
 */

import {
  compareIntentToActual,
  typeFamily,
  type RecordedIntent,
  type ActualColumn,
} from '@/lib/autonomy/intent-conformance'

const intent = (over: Partial<RecordedIntent> = {}): RecordedIntent => ({
  tableName: 'budgets',
  columnName: 'start_date',
  requestedType: 'timestamp',
  requestedNullable: null,
  requestedFkTo: null,
  ...over,
})

const column = (over: Partial<ActualColumn> = {}): ActualColumn => ({
  tableName: 'budgets',
  columnName: 'start_date',
  dataType: 'timestamp without time zone',
  nullable: false,
  ...over,
})

describe('typeFamily', () => {
  it('treats equivalent spellings as the same family', () => {
    expect(typeFamily('timestamp')).toBe(typeFamily('timestamp without time zone'))
    expect(typeFamily('timestamptz')).toBe(typeFamily('timestamp with time zone'))
    expect(typeFamily('int')).toBe(typeFamily('integer'))
    expect(typeFamily('bigint')).toBe(typeFamily('smallint'))
    expect(typeFamily('decimal')).toBe(typeFamily('numeric'))
    expect(typeFamily('text')).toBe(typeFamily('character varying'))
    expect(typeFamily('bool')).toBe(typeFamily('boolean'))
  })

  it('ignores precision — numeric(10,2) is still numeric', () => {
    expect(typeFamily('numeric(10,2)')).toBe(typeFamily('numeric'))
  })

  it('keeps genuinely different kinds apart', () => {
    expect(typeFamily('timestamp')).not.toBe(typeFamily('integer'))
    expect(typeFamily('uuid')).not.toBe(typeFamily('text'))
    expect(typeFamily('jsonb')).not.toBe(typeFamily('text'))
    expect(typeFamily('boolean')).not.toBe(typeFamily('integer'))
  })
})

describe('type drift — the May 2026 defect', () => {
  it('FIRES when a requested timestamp was built as integer', () => {
    const report = compareIntentToActual(
      [intent({ requestedType: 'timestamp' })],
      [column({ dataType: 'integer' })],
    )

    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]).toMatchObject({
      table: 'budgets',
      column: 'start_date',
      kind: 'type_drift',
      requested: 'timestamp',
      actual: 'integer',
    })
    // The detail must be actionable on its own — it is what an operator reads.
    expect(report.findings[0].detail).toContain('start_date')
    expect(report.findings[0].detail).toContain('integer')
  })

  it('stays SILENT when the column matches what was requested', () => {
    const report = compareIntentToActual(
      [intent({ requestedType: 'timestamp' })],
      [column({ dataType: 'timestamp without time zone' })],
    )
    expect(report.findings).toHaveLength(0)
    expect(report.checked).toBe(1)
  })

  it('does not fire on a harmless spelling difference', () => {
    const report = compareIntentToActual(
      [intent({ requestedType: 'int' })],
      [column({ dataType: 'bigint' })],
    )
    expect(report.findings).toHaveLength(0)
  })
})

describe('nullability drift', () => {
  it('FIRES when a column requested nullable is NOT NULL', () => {
    // The enrichment defect: a fully-specified table became uninsertable
    // because added columns inherited NOT NULL.
    const report = compareIntentToActual(
      [intent({ columnName: 'note', requestedType: 'text', requestedNullable: true })],
      [column({ columnName: 'note', dataType: 'text', nullable: false })],
    )
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0].kind).toBe('nullability_drift')
  })

  it('stays SILENT when the column really is nullable', () => {
    const report = compareIntentToActual(
      [intent({ columnName: 'note', requestedType: 'text', requestedNullable: true })],
      [column({ columnName: 'note', dataType: 'text', nullable: true })],
    )
    expect(report.findings).toHaveLength(0)
  })

  it('does not fire when nullability was never stated', () => {
    const report = compareIntentToActual(
      [intent({ requestedNullable: null })],
      [column({ nullable: false })],
    )
    expect(report.findings).toHaveLength(0)
  })
})

describe('missing foreign key', () => {
  it('FIRES when a requested fkTo produced no constraint', () => {
    // The irregular-plural defect: category_id never resolved to "categories".
    const report = compareIntentToActual(
      [intent({ columnName: 'category_id', requestedType: 'uuid', requestedFkTo: 'categories' })],
      [column({ columnName: 'category_id', dataType: 'uuid' })],
      new Set(), // no FKs exist
    )
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0].kind).toBe('missing_fk')
  })

  it('stays SILENT when the foreign key exists', () => {
    const report = compareIntentToActual(
      [intent({ columnName: 'category_id', requestedType: 'uuid', requestedFkTo: 'categories' })],
      [column({ columnName: 'category_id', dataType: 'uuid' })],
      new Set(['budgets.category_id']),
    )
    expect(report.findings).toHaveLength(0)
  })
})

describe('missing column', () => {
  it('FIRES when a requested column is absent from a table that still exists', () => {
    const report = compareIntentToActual(
      [intent({ columnName: 'ghost' })],
      [column({ columnName: 'start_date' })], // table present, ghost is not
    )
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0].kind).toBe('missing_column')
  })

  it('does NOT fire when the whole table was dropped — that is a legitimate outcome', () => {
    const report = compareIntentToActual([intent()], [])
    expect(report.findings).toHaveLength(0)
    expect(report.unverifiable).toBe(1)
  })
})

describe('honest reporting', () => {
  it('never reports a clean bill of health for an empty ledger', () => {
    // "0 findings" from 0 checks is not evidence of correctness. Callers must
    // be able to distinguish "verified clean" from "nothing was verified".
    const report = compareIntentToActual([], [column()])
    expect(report.findings).toHaveLength(0)
    expect(report.checked).toBe(0)
  })

  it('counts unverifiable columns separately from clean ones', () => {
    const report = compareIntentToActual(
      [intent({ tableName: 'dropped_table' }), intent()],
      [column()],
    )
    expect(report.checked).toBe(2)
    expect(report.unverifiable).toBe(1)
    expect(report.findings).toHaveLength(0)
  })

  it('reports every distinct problem on the same column', () => {
    const report = compareIntentToActual(
      [intent({
        columnName: 'category_id',
        requestedType: 'uuid',
        requestedNullable: true,
        requestedFkTo: 'categories',
      })],
      [column({ columnName: 'category_id', dataType: 'text', nullable: false })],
    )
    const kinds = report.findings.map((f) => f.kind).sort()
    expect(kinds).toEqual(['missing_fk', 'nullability_drift', 'type_drift'])
  })
})
