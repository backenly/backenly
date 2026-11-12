/**
 * Every argument an agent can pass says what it is. Production QA
 * (2026-11-09): set_rls `tableName` and the db_insert/db_update/db_delete
 * `table` arguments had no description in tools/list, so an agent had to guess
 * from the name. Checked over what a read-write and a read-only key see.
 */
import { buildCatalog } from '@/lib/mcp/catalog'

function undescribed(readOnly: boolean): string[] {
  return buildCatalog({ readOnly }).flatMap((t) =>
    Object.entries<{ description?: unknown }>((t.inputSchema as { properties?: Record<string, { description?: unknown }> })?.properties ?? {})
      .filter(([, schema]) => typeof schema?.description !== 'string' || !schema.description.trim())
      .map(([name]) => `${t.name}.${name}`),
  )
}

it('describes every argument of every tool a read-write key is offered', () => {
  expect(undescribed(false)).toEqual([])
})

it('describes every argument of every tool a read-only key is offered', () => {
  expect(undescribed(true)).toEqual([])
})
