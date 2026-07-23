/**
 * run_query has exactly one definition.
 *
 * It was briefly registered twice — once hand-written in the catalog and once
 * as a brain tool — which would have published two descriptions of one tool,
 * free to drift apart. The catalog exists specifically to stop that, so the
 * invariant is asserted rather than trusted.
 */

import { buildCatalog, buildDispatchable } from '@/lib/mcp/catalog'
import { READ_ONLY_TOOLS } from '@/lib/ai/brain/tools'

describe('run_query registration', () => {
  const catalog = buildCatalog()

  it('appears in the catalog exactly once', () => {
    expect(catalog.filter((t) => t.name === 'run_query')).toHaveLength(1)
  })

  it('is classified read-only, so it can never reach a destructive gate', () => {
    expect(READ_ONLY_TOOLS.has('run_query' as never)).toBe(true)
  })

  it('requires sql and accepts an optional limit', () => {
    const tool = catalog.find((t) => t.name === 'run_query')!
    expect(tool.inputSchema.required).toContain('sql')
    expect(Object.keys(tool.inputSchema.properties)).toEqual(
      expect.arrayContaining(['sql', 'limit']),
    )
  })

  it('names the write doors, so a write is never sent to the read tool', () => {
    // The description is the only thing steering tool choice at runtime, so the
    // steer is part of the contract, not prose. Writes-sent-to-run_query was the
    // largest error class on the live key; the cure is telling the model where
    // writes go at the moment it is reading about reads.
    const tool = catalog.find((t) => t.name === 'run_query')!
    expect(tool.description).toMatch(/join|aggregate/i)
    expect(tool.description).toMatch(/apply_migration/)
    expect(tool.description).toMatch(/db_insert/)
  })

  it('does not steer toward a tool it no longer advertises', () => {
    // db_query stays dispatchable for pinned clients but is deliberately
    // unlisted, so advertising a comparison against it is dead context.
    const tool = catalog.find((t) => t.name === 'run_query')!
    expect(tool.description).not.toMatch(/db_query/)
  })

  it('keeps db_query callable for older clients while unlisting it', () => {
    // Removing it from the catalog is the reliability win (query / db_query /
    // run_query were three similar names). 404-ing it would break a working
    // setup for no gain, so dispatchable and advertised deliberately differ.
    expect(buildDispatchable().some((t) => t.name === 'db_query')).toBe(true)
    expect(catalog.some((t) => t.name === 'db_query')).toBe(false)
  })

  it('has no duplicate tool names anywhere in the catalog', () => {
    const names = catalog.map((t) => t.name)
    expect(names).toHaveLength(new Set(names).size)
  })

  it('stays small enough for reliable tool selection', () => {
    // Selection accuracy degrades past ~20 tools and collapses past ~50. This
    // surface was 71. The bound is the whole point of the redesign, so it is
    // asserted rather than left to drift back.
    expect(catalog.length).toBeLessThanOrEqual(20)
  })
})
