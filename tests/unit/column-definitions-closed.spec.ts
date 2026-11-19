/**
 * What the executor writes into DDL from a column definition is closed
 * (lib/ai/minimal-executor.ts): a column's type must be one of PostgreSQL's own
 * type names (SAFE_COLUMN_TYPE, checked after normalization), and table and
 * column names must be plain identifiers (assertSafeSqlName). Anything a caller
 * appends to a type name, or a quote inside a name, would otherwise be written
 * into CREATE TABLE or ALTER TABLE as a clause.
 */

import { UnsafeColumnDefinitionError, assertSafeSqlName, isSafeColumnType } from '@/lib/ai/minimal-executor'

describe('column types', () => {
  it.each([
    'TEXT',
    'TEXT[]',
    'CITEXT',
    'VARCHAR(255)',
    'CHARACTER VARYING(40)',
    'INTEGER',
    'BIGINT[]',
    'BOOLEAN',
    'NUMERIC(10,2)',
    'NUMERIC(10, 2)',
    'DECIMAL(12,4)',
    'DOUBLE PRECISION',
    'TIMESTAMP',
    'TIMESTAMP WITH TIME ZONE',
    'TIMESTAMPTZ(3)',
    'TIME WITHOUT TIME ZONE',
    'INTERVAL',
    'UUID',
    'JSONB',
    'BYTEA',
    'VECTOR(1536)',
  ])('accepts %s', (type) => {
    expect(isSafeColumnType(type)).toBe(true)
  })

  it.each([
    'TEXT REFERENCES USERS (EMAIL)',
    'TEXT DEFAULT QUERY_TO_XML(1)',
    'DECIMAL(10,2) REFERENCES USERS(ID)',
    'NUMERIC(10,2) DEFAULT 0',
    'TEXT GENERATED ALWAYS AS (A) STORED',
    'TEXT CHECK (1=1)',
    'TEXT COLLATE "C"',
    'INTEGER NOT NULL',
    'TEXT[] DEFAULT X',
    'TEXT); DROP TABLE X; --',
    'VARCHAR(255',
    '',
  ])('refuses %j', (type) => {
    expect(isSafeColumnType(type)).toBe(false)
  })
})

describe('table and column names', () => {
  it.each(['posts', 'user_id', '_private', 'Order2', 'a$b'])('accepts %s', (name) => {
    expect(assertSafeSqlName(name, 'column')).toBe(name)
  })

  it.each(['x" TEXT DEFAULT 1, "y', 'a b', '1st', 'semi;colon', 'quote"', '', 'x'.repeat(64), null, 42])('refuses %j', (name) => {
    expect(() => assertSafeSqlName(name, 'column')).toThrow(UnsafeColumnDefinitionError)
  })
})
