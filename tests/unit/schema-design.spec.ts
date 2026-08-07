/**
 * The schema-design rule set, proved without a database.
 *
 * These four judgements decide whether an owner is told their schema is wrong,
 * and every one of them is a claim about STATISTICS rather than about SQL. Two
 * things therefore have to hold and neither is checkable by reading the query:
 *
 *   1. the sign convention of `n_distinct` is decoded correctly (positive is an
 *      absolute count, negative is a fraction of the table). Reading -1 as "one
 *      distinct value" instead of "all values distinct" turns every primary key
 *      into an enum finding.
 *   2. a table the builder just created reports NOTHING. `reltuples` is -1 until
 *      autovacuum analyses a table, so the row thresholds are also the evidence
 *      gate, and that is the property tests/probes/fresh-build-is-born-clean
 *      exists to protect at the whole-catalogue level.
 */

import {
  classifyDesignDefects,
  distinctCount,
  MIN_ROWS_FOR_DESIGN_CLAIM,
  type ColumnStat,
} from '@/lib/autonomy/schema-design'

/** A column with everything correct, so each test varies exactly one thing. */
function col(over: Partial<ColumnStat> = {}): ColumnStat {
  return {
    tableName: 'orders',
    columnName: 'note',
    dataType: 'text',
    estRows: 5_000,
    notNull: false,
    nullFrac: 0.5,
    nDistinct: -0.5,
    hasFk: false,
    hasCheck: false,
    hasUnique: false,
    ...over,
  }
}

describe('distinctCount decodes the n_distinct sign convention', () => {
  it('reads a positive value as an absolute count', () => {
    expect(distinctCount(5, 10_000)).toBe(5)
  })

  it('reads -1 as every row distinct, not as one distinct value', () => {
    // The bug this pins: -1 means "n_distinct scales with the table", i.e. a
    // unique column. Treated as a literal 1 it would look like a constant.
    expect(distinctCount(-1, 10_000)).toBe(10_000)
  })

  it('reads a fraction as that share of the table', () => {
    expect(distinctCount(-0.5, 1_000)).toBe(500)
  })

  it('has no answer without a statistic', () => {
    expect(distinctCount(null, 1_000)).toBeNull()
    expect(distinctCount(0, 1_000)).toBeNull()
  })
})

describe('a backend with no statistics yet is reported clean', () => {
  it('says nothing about a table that has never been analysed', () => {
    // reltuples = -1 is what Postgres reports before the first ANALYZE, which is
    // the state of every table the builder just created.
    const fresh: ColumnStat[] = [
      col({ tableName: 'orders', columnName: 'user_id', estRows: -1, hasFk: true, nullFrac: 0 }),
      col({ tableName: 'users', columnName: 'email', estRows: -1, nullFrac: 0, nDistinct: -1 }),
      col({ tableName: 'orders', columnName: 'status', estRows: -1, nDistinct: 3 }),
    ]
    expect(classifyDesignDefects(fresh)).toEqual([])
  })

  it('says nothing about a table below the evidence threshold', () => {
    const tiny = col({
      columnName: 'user_id',
      hasFk: true,
      nullFrac: 0,
      estRows: MIN_ROWS_FOR_DESIGN_CLAIM - 1,
    })
    expect(classifyDesignDefects([tiny])).toEqual([])
  })
})

describe('money_as_float', () => {
  it('flags a price stored in double precision, even with no rows', () => {
    // Wrong at zero rows too, and cheapest to fix before there is data.
    const d = classifyDesignDefects([
      col({ columnName: 'price', dataType: 'double precision', estRows: -1 }),
    ])
    expect(d).toHaveLength(1)
    expect(d[0].kind).toBe('money_as_float')
    expect(d[0].sql).toContain('numeric(12,2)')
  })

  it('flags real as well as double precision', () => {
    const d = classifyDesignDefects([col({ columnName: 'total_amount', dataType: 'real' })])
    expect(d[0]?.kind).toBe('money_as_float')
  })

  it('leaves numeric alone, which is the correct type', () => {
    expect(
      classifyDesignDefects([col({ columnName: 'price', dataType: 'numeric(12,2)' })]),
    ).toEqual([])
  })

  it('does not flag a non-money float', () => {
    // `latitude` is genuinely floating point. Matching on type alone would file
    // a migration against every scientific column in the database.
    expect(
      classifyDesignDefects([col({ columnName: 'latitude', dataType: 'double precision' })]),
    ).toEqual([])
  })
})

describe('nullable_fk', () => {
  it('flags an optional foreign key the data says is mandatory', () => {
    const d = classifyDesignDefects([
      col({ columnName: 'user_id', hasFk: true, notNull: false, nullFrac: 0, estRows: 12_000 }),
    ])
    expect(d).toHaveLength(1)
    expect(d[0].kind).toBe('nullable_fk')
    expect(d[0].sql).toContain('SET NOT NULL')
  })

  it('stays quiet when the column genuinely is sometimes null', () => {
    expect(
      classifyDesignDefects([
        col({ columnName: 'user_id', hasFk: true, nullFrac: 0.02 }),
      ]),
    ).toEqual([])
  })

  it('stays quiet when the column is already NOT NULL', () => {
    expect(
      classifyDesignDefects([
        col({ columnName: 'user_id', hasFk: true, notNull: true, nullFrac: 0 }),
      ]),
    ).toEqual([])
  })

  it('ignores a bare *_id with no FK, which another probe owns', () => {
    // detectFkColumnsMissingConstraints reports that. Reporting it here too
    // would bill one mistake to the owner twice.
    expect(
      classifyDesignDefects([col({ columnName: 'user_id', hasFk: false, nullFrac: 0 })]),
    ).toEqual([])
  })
})

describe('missing_unique', () => {
  it('flags an email column that is already fully distinct', () => {
    const d = classifyDesignDefects([
      col({ tableName: 'users', columnName: 'email', nullFrac: 0, nDistinct: -1, estRows: 8_000 }),
    ])
    expect(d).toHaveLength(1)
    expect(d[0].kind).toBe('missing_unique')
    expect(d[0].sql).toContain('CREATE UNIQUE INDEX')
  })

  it('stays quiet once a unique index exists', () => {
    expect(
      classifyDesignDefects([
        col({ columnName: 'email', nullFrac: 0, nDistinct: -1, hasUnique: true }),
      ]),
    ).toEqual([])
  })

  it('stays quiet when values repeat', () => {
    // -0.4 means 40% distinct, so duplicates already exist and a UNIQUE index
    // would fail. Proposing it would be worse than silence.
    expect(
      classifyDesignDefects([col({ columnName: 'email', nullFrac: 0, nDistinct: -0.4 })]),
    ).toEqual([])
  })

  it('does not invent uniqueness for an unnamed column', () => {
    // Plenty of columns happen to be all-distinct without uniqueness being
    // intended, and a wrong UNIQUE breaks writes.
    expect(
      classifyDesignDefects([col({ columnName: 'description', nullFrac: 0, nDistinct: -1 })]),
    ).toEqual([])
  })
})

describe('unconstrained_enum', () => {
  it('flags a status column holding a handful of repeated values', () => {
    const d = classifyDesignDefects([
      col({ columnName: 'status', dataType: 'text', nDistinct: 4, estRows: 20_000 }),
    ])
    expect(d).toHaveLength(1)
    expect(d[0].kind).toBe('unconstrained_enum')
    expect(d[0].sql).toContain('CHECK')
  })

  it('handles varchar as well as text', () => {
    const d = classifyDesignDefects([
      col({ columnName: 'role', dataType: 'character varying(32)', nDistinct: 3 }),
    ])
    expect(d[0]?.kind).toBe('unconstrained_enum')
  })

  it('stays quiet when a CHECK constraint already exists', () => {
    expect(
      classifyDesignDefects([
        col({ columnName: 'status', dataType: 'text', nDistinct: 4, hasCheck: true }),
      ]),
    ).toEqual([])
  })

  it('stays quiet for an FK, whose values are constrained by the parent table', () => {
    // nullFrac is deliberately non-zero: an FK with nullFrac 0 is a genuine
    // nullable_fk defect, so leaving it at 0 here would test the wrong rule and
    // pass for the wrong reason.
    expect(
      classifyDesignDefects([
        col({ columnName: 'type', dataType: 'text', nDistinct: 4, hasFk: true, nullFrac: 0.1 }),
      ]),
    ).toEqual([])
  })

  it('stays quiet when the value set is too wide to be an enum', () => {
    expect(
      classifyDesignDefects([col({ columnName: 'type', dataType: 'text', nDistinct: 40 })]),
    ).toEqual([])
  })

  it('stays quiet for a single-value column, which is unused rather than an enum', () => {
    expect(
      classifyDesignDefects([col({ columnName: 'status', dataType: 'text', nDistinct: 1 })]),
    ).toEqual([])
  })
})

describe('finding identity', () => {
  it('keys on the defect kind so one column can carry two independently', () => {
    // A table-scoped or column-scoped key would let fixing the first defect
    // withdraw the finding for the second.
    const d = classifyDesignDefects([
      col({ tableName: 'orders', columnName: 'price', dataType: 'double precision' }),
      col({ tableName: 'orders', columnName: 'user_id', hasFk: true, nullFrac: 0 }),
    ])
    expect(d.map(x => `${x.kind}:${x.tableName}.${x.columnName}`)).toEqual([
      'money_as_float:orders.price',
      'nullable_fk:orders.user_id',
    ])
  })
})
