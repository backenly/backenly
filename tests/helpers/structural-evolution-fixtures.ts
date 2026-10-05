/**
 * A synthetic `orders` table, as `readTableFacts` would describe it, for the
 * structural-evolution suites that hold pure logic without a database.
 *
 * The integration suite builds the same shape in a real PostgreSQL; keep the
 * two in step when one changes.
 */

import type { ColumnFact, TableFacts } from '@/lib/structural-evolution/facts'

export function col(name: string, type = 'text', over: Partial<ColumnFact> = {}): ColumnFact {
  const udt = type === 'timestamp with time zone' ? 'timestamptz' : type
  return { name, attnum: 0, type, udt, notNull: false, default: null, generated: false, identity: false, hasColumnAcl: false, ...over }
}

export function ordersFacts(over: Partial<TableFacts> = {}): TableFacts {
  const columns: ColumnFact[] = [
    col('id', 'uuid', { notNull: true }),
    col('user_id', 'uuid', { notNull: true }),
    col('total', 'numeric', { notNull: true }),
    col('status', 'text', { notNull: true }),
    col('created_at', 'timestamp with time zone', { notNull: true }),
    col('refund_amount', 'numeric'),
    col('refund_reason'),
    col('refunded_at', 'timestamp with time zone'),
    col('coupon_code'),
    col('discount_amount', 'numeric'),
    col('shipping_address'),
    col('shipping_method'),
  ].map((c, i) => ({ ...c, attnum: i + 1 }))
  return {
    schema: 'workspace_test',
    table: 'orders',
    oid: 1,
    relkind: 'r',
    owner: 'backenly_user',
    rowSecurity: true,
    forceRowSecurity: true,
    columns,
    primaryKey: ['id'],
    constraints: [
      { name: 'orders_pkey', kind: 'p', columns: ['id'], definition: 'PRIMARY KEY (id)', validated: true },
      { name: 'orders_refund_amount_check', kind: 'c', columns: ['refund_amount'], definition: 'CHECK ((refund_amount >= (0)::numeric))', validated: true },
    ],
    inboundForeignKeys: [],
    indexes: [],
    policies: [],
    triggers: [],
    grants: [
      { grantee: 'authenticated', privilege: 'SELECT' },
      { grantee: 'authenticated', privilege: 'UPDATE' },
    ],
    dependents: [],
    stats: { liveRows: 50_000, inserts: 0, updates: 0, hotUpdates: 0, deletes: 0, seqScans: 0, idxScans: 0 },
    ...over,
  }
}
