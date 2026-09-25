/**
 * MCP tool annotations: what a host reads to tell a read from a write before it
 * calls anything.
 *
 * The rule that matters is agreement. `readOnlyHint` must say exactly what the
 * read-only key enforcement says (`isReadOnlyTool`), or a host could auto-run a
 * tool it believes is a read while the server treats it as a write. Both
 * transports serve these from the catalog, so the catalog is what is pinned
 * here, plus one check that the remote endpoint actually sends them.
 */

import '../helpers/real-web-standard'
import { NextRequest } from 'next/server'

jest.mock('@/lib/mcp/auth', () => {
  const actual = jest.requireActual('@/lib/mcp/auth')
  return {
    ...actual,
    authenticateMcp: jest.fn(async () => ({ success: true, projectId: 'p1', userId: 'u1', keyId: 'k1', readOnly: false })),
  }
})

import { annotationsFor, buildCatalog, buildDispatchable, isReadOnlyTool } from '@/lib/mcp/catalog'
import { POST } from '@/app/api/mcp/route'

describe('catalog annotations', () => {
  const dispatchable = buildDispatchable()

  it('every dispatchable tool carries annotations with a title', () => {
    for (const t of dispatchable) {
      expect(t.annotations).toBeDefined()
      expect(t.annotations!.title.length).toBeGreaterThan(0)
    }
  })

  it('readOnlyHint agrees with the read-only key enforcement for every tool', () => {
    const disagree = dispatchable
      .filter((t) => t.annotations!.readOnlyHint !== isReadOnlyTool(t.name))
      .map((t) => t.name)
    expect(disagree).toEqual([])
  })

  it('never marks a read as destructive', () => {
    const contradictory = dispatchable
      .filter((t) => t.annotations!.readOnlyHint && t.annotations!.destructiveHint)
      .map((t) => t.name)
    expect(contradictory).toEqual([])
  })

  it('marks the row writes that can overwrite or remove data as destructive', () => {
    expect(annotationsFor('db_delete').destructiveHint).toBe(true)
    expect(annotationsFor('db_update').destructiveHint).toBe(true)
    expect(annotationsFor('db_insert').destructiveHint).toBe(false)
  })

  it('marks the obvious reads read-only and the obvious writes not', () => {
    for (const read of ['read_backend_state', 'run_query', 'get_table_schema', 'fetch_docs', 'generate_types', 'check_approval']) {
      expect({ read, hint: annotationsFor(read).readOnlyHint }).toEqual({ read, hint: true })
    }
    for (const write of ['backend_chat', 'apply_migration', 'set_rls', 'branch', 'create_api_key', 'deploy', 'connect']) {
      expect({ write, hint: annotationsFor(write).readOnlyHint }).toEqual({ write, hint: false })
    }
  })

  it('marks exactly the tools that reach an outside provider as open-world', () => {
    const openWorld = dispatchable.filter((t) => t.annotations!.openWorldHint).map((t) => t.name).sort()
    expect(openWorld).toEqual(['backend_chat', 'integrations', 'send_push', 'store_integration_key', 'webhooks'])
  })

  it('titles the advertised tools in words, not snake_case', () => {
    for (const t of buildCatalog()) expect(t.annotations!.title).not.toMatch(/_/)
  })
})

describe('remote tools/list', () => {
  it('sends a title and annotations for every advertised tool', async () => {
    const res = await POST(
      new NextRequest('https://backenly.test/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'mcp_live_test_key' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    )
    const body = await res.json()
    const tools: any[] = body.result.tools

    expect(tools.length).toBe(buildCatalog().length)
    for (const t of tools) {
      expect(typeof t.title).toBe('string')
      expect(t.annotations).toEqual(annotationsFor(t.name))
    }
  })
})
