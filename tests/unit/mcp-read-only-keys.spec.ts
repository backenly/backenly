/**
 * Read-only MCP keys.
 *
 * The guarantee being defended: a key issued read-only cannot change the
 * backend, and the model is never even offered a tool that would.
 *
 * These assertions are structural on purpose. The runtime enforcement lives in
 * four routes (tool, chat, db/insert, db/update, db/delete) and the advertised
 * surface is filtered in two more (manifest, the remote JSON-RPC route). A test
 * that only checked one of those would pass while another quietly served a
 * write — the exact failure mode the shared `refuseIfReadOnly` predicate and
 * this spec exist to prevent.
 *
 * The read-only catalog is derived, never hand-listed. Hand-listing it would
 * mean a tool added to MCP_SURFACE later defaults to "safe" by omission, which
 * is the wrong direction to fail.
 */

import { buildCatalog, isReadOnlyTool } from '@/lib/mcp/catalog'
import { READ_ONLY_TOOLS, isDestructiveTool } from '@/lib/ai/brain/tools'

describe('the read-only catalog', () => {
  const full = buildCatalog()
  const ro = buildCatalog({ readOnly: true })
  const names = (list: { name: string }[]) => list.map((t) => t.name)

  it('is a strict subset of the full catalog', () => {
    expect(ro.length).toBeGreaterThan(0)
    expect(ro.length).toBeLessThan(full.length)
    for (const t of names(ro)) expect(names(full)).toContain(t)
  })

  it('offers no tool that can change the backend', () => {
    // Every advertised name must clear the same predicate the routes enforce.
    for (const name of names(ro)) expect(isReadOnlyTool(name)).toBe(true)
  })

  it('offers no destructive tool', () => {
    for (const name of names(ro)) expect(isDestructiveTool(name)).toBe(false)
  })

  it('still carries the tools that make a read-only agent useful', () => {
    // A read-only mode that cannot answer questions about the backend is a
    // toggle nobody turns on. These four are the reason the mode is worth having.
    expect(names(ro)).toEqual(
      expect.arrayContaining(['run_query', 'read_backend_state', 'get_table_schema', 'fetch_docs']),
    )
  })

  it('withholds every write door, including the natural-language one', () => {
    // backend_chat is the subtle one: the brain applies non-destructive changes
    // without ever reaching the destructive gate, so "read-only" cannot mean
    // "read-only unless the model is asked nicely".
    const withheld = [
      'backend_chat',
      'apply_migration',
      'db_insert',
      'db_update',
      'db_delete',
      'set_rls',
      'enable_auth',
      'create_bucket',
      'generate_function',
      'enable_realtime',
      'create_api_key',
      'set_env_var',
      'branch',
      'get_database_credentials',
    ]
    for (const name of withheld) {
      expect(names(full)).toContain(name)      // it is a real advertised tool…
      expect(names(ro)).not.toContain(name)    // …and read-only keys never see it
      expect(isReadOnlyTool(name)).toBe(false) // …and would be refused if called
    }
  })

  it('leaves the read-write catalog untouched', () => {
    // Regression guard: adding the mode must not have shrunk the default surface.
    expect(names(buildCatalog())).toEqual(names(full))
  })
})

describe('isReadOnlyTool', () => {
  it('accepts the brain read tools without restating them', () => {
    for (const name of Array.from(READ_ONLY_TOOLS)) {
      expect(isReadOnlyTool(name as string)).toBe(true)
    }
  })

  it('rejects an unknown tool rather than defaulting to safe', () => {
    // A tool nobody classified must not be servable to a read-only key.
    expect(isReadOnlyTool('some_tool_added_next_year')).toBe(false)
  })
})
