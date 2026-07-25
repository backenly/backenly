import { BRAIN_TOOLS, TOOL_TO_ACTION, isDestructiveTool, READ_ONLY_TOOLS } from '@/lib/ai/brain/tools'
import { buildCatalog, catalogByName } from '@/lib/mcp/catalog'
import { resolveCustomCommands } from '@/lib/services/workspace-rls'

const decl = () => (BRAIN_TOOLS as any[]).find((t) => t.function.name === 'set_rls')
const map = (args: any) => TOOL_TO_ACTION['set_rls'](args)

// A predicate that names the caller, so nothing here trips the identity guard.
const P = "sender_id::text = backenly_jwt_claim('sub')"
const READ = "is_public OR owner_id::text = backenly_jwt_claim('sub')"
const okValidate = (e: string) => ({ ok: true as const, expression: e })

describe('set_rls is declared and forwards every argument', () => {
  it('is advertised with the four commands as top-level arguments', () => {
    const d = decl()
    expect(d).toBeTruthy()
    for (const c of ['select', 'insert', 'update', 'delete']) {
      expect(d.function.parameters.properties).toHaveProperty(c)
    }
  })

  it('forwards a SUBSET as a scoped edit — the other commands are absent, not defaulted', () => {
    const a = map({ tableName: 'messages', update: { using: P }, delete: { using: P } })
    expect(a.params.template).toBe('custom')
    expect(Object.keys(a.params.commands).sort()).toEqual(['delete', 'update'])
    expect(a.params.commands.select).toBeUndefined()
    expect(a.params.commands.insert).toBeUndefined()
  })

  it('forwards using AND check on update rather than collapsing them', () => {
    const a = map({ tableName: 'p', update: { using: READ, check: P } })
    expect(a.params.commands.update).toEqual({ using: READ, check: P })
  })

  it('accepts a bare string as shorthand', () => {
    const a = map({ tableName: 'p', delete: P })
    expect(a.params.commands.delete).toBe(P)
  })
})

describe('a scoped set_rls edit preserves the commands it did not name', () => {
  it('marks the plan scoped and targets ONLY the named commands', () => {
    const plan = resolveCustomCommands(
      { commands: { update: { using: P }, delete: { using: P } } },
      okValidate,
    )
    expect(plan.kind).toBe('ok')
    if (plan.kind !== 'ok') return
    expect(plan.scoped).toBe(true)
    expect(plan.rules.map((r) => r.command).sort()).toEqual(['delete', 'update'])
  })

  it('keeps a narrowing conjunct verbatim instead of simplifying to the broad clause', () => {
    // The reported failure: `P AND sender_id = sub` came back as `P`.
    const narrowed = `${READ} AND sender_id::text = backenly_jwt_claim('sub')`
    const plan = resolveCustomCommands({ commands: { update: { using: narrowed } } }, okValidate)
    expect(plan.kind).toBe('ok')
    if (plan.kind !== 'ok') return
    expect(plan.rules[0].using).toBe(narrowed)
    expect(plan.rules[0].using).toContain('AND')
  })

  it('gives each command a DIFFERENT predicate when asked to', () => {
    const plan = resolveCustomCommands(
      {
        commands: {
          select: { using: READ },
          insert: { check: P },
          update: { using: P, check: P },
          delete: { using: P },
        },
      },
      okValidate,
    )
    expect(plan.kind).toBe('ok')
    if (plan.kind !== 'ok') return
    const by = Object.fromEntries(plan.rules.map((r) => [r.command, r]))
    expect(by.select.using).toBe(READ)
    expect(by.delete.using).toBe(P)
    expect(by.select.using).not.toBe(by.delete.using)
  })
})

describe('set_rls is reachable over MCP without the brain', () => {
  it('is advertised in the manifest an MCP host actually reads', () => {
    expect(buildCatalog().some((t: any) => t.name === 'set_rls')).toBe(true)
  })

  it('dispatches through the typed /api/mcp/tool path', () => {
    // That route only executes tools present in the dispatch catalog. Being
    // merely declared to the brain is not enough — that was the whole reason
    // RLS had no door except backend_chat.
    expect(catalogByName('set_rls')).toBeTruthy()
  })

  it('is not gated behind destructive approval', () => {
    // Writing a policy is a governed mutation, not an irreversible one; routing
    // it through the human Review Queue would put it back behind a wait.
    expect(isDestructiveTool('set_rls')).toBe(false)
  })

  it('counts as a mutation, not a read', () => {
    expect((READ_ONLY_TOOLS as Set<string>).has('set_rls')).toBe(false)
  })
})
