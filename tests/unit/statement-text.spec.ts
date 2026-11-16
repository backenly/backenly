/**
 * A statement's text read the way PostgreSQL reads it (lib/autonomy/statement-text.ts):
 * comments removed, quoted identifiers, strings and dollar-quoted bodies taken
 * as whole tokens. Which project a statement belongs to, and which table it
 * reads, are both decided on this reading.
 */
import { namesSchema, statementClauses, withoutComments } from '@/lib/autonomy/statement-text'

const S = 'workspace_5f0c2a9e-7d41-4b8e-9a63-0e2d7c1b8f44'

describe('withoutComments', () => {
  it('removes line and block comments, and keeps everything else as written', () => {
    expect(withoutComments(`SELECT 1 -- a note\nFROM t /* why */ WHERE x = $1`)).toBe(`SELECT 1  \nFROM t   WHERE x = $1`)
  })

  it('nests block comments, as PostgreSQL does', () => {
    expect(withoutComments(`SELECT /* a /* b */ c */ 1`)).toBe(`SELECT   1`)
  })

  it('leaves comment markers inside strings, identifiers and dollar quotes alone', () => {
    const q = `SELECT '-- not a comment', "a /* b", $$ /* body */ $$, $tag$ -- x $tag$`
    expect(withoutComments(q)).toBe(q)
  })

  it('reads $1 as a parameter, not a dollar quote', () => {
    expect(withoutComments(`SELECT * FROM t WHERE a = $1 /* c */ AND b = $2`)).toBe(`SELECT * FROM t WHERE a = $1   AND b = $2`)
  })
})

describe('statementClauses', () => {
  it('replaces strings and dollar-quoted bodies, and keeps quoted identifiers', () => {
    expect(statementClauses(`SELECT "a" FROM "s"."t" WHERE "b" = 'x' AND c = $$y$$`)).toBe(`SELECT "a" FROM "s"."t" WHERE "b" = $0 AND c = $0`)
  })
})

describe('namesSchema', () => {
  const wrap = (read: string) => `WITH pgrst_source AS ( ${read} )  SELECT pg_catalog.count(_postgrest_t) AS page_total FROM ( SELECT * FROM pgrst_source ) _postgrest_t`

  it('finds the schema PostgREST qualifies every name with', () => {
    expect(namesSchema(wrap(`SELECT "${S}"."orders".* FROM "${S}"."orders" WHERE  "${S}"."orders"."status" = $1`), S)).toBe(true)
  })

  it('finds an unquoted qualifier, folded to lower case', () => {
    expect(namesSchema(`SELECT * FROM Workspace_abc.orders`, 'workspace_abc')).toBe(true)
  })

  it('does not find a schema whose name only begins with this one', () => {
    expect(namesSchema(`SELECT * FROM "${S}_br_scratch"."orders"`, S)).toBe(false)
  })

  it('does not find a name that is not used as a qualifier', () => {
    expect(namesSchema(`SELECT 1 AS "${S}"`, S)).toBe(false)
  })

  it('does not find a name inside a comment, a string or a dollar-quoted body', () => {
    expect(namesSchema(`SELECT 1 /* "${S}"."orders" */`, S)).toBe(false)
    expect(namesSchema(`SELECT 1 -- "${S}"."orders"`, S)).toBe(false)
    expect(namesSchema(`SELECT 1 /* a /* b */ "${S}"."orders" */`, S)).toBe(false)
    expect(namesSchema(`SELECT '"${S}"."orders"'`, S)).toBe(false)
    expect(namesSchema(`SELECT $$ "${S}"."orders" $$`, S)).toBe(false)
  })

  it('reads a quoted identifier whole, doubled quotes included', () => {
    expect(namesSchema(`SELECT * FROM "a""${S}""b"."orders"`, S)).toBe(false)
  })
})
