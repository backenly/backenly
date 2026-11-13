/**
 * Every advertised tool names the docs topic that has its long form, and
 * fetch_docs serves that topic.
 *
 * Production QA (2026-11-09, report 99): tools/list was about 49 KB, sent to
 * the model before the user typed anything. It now says what an agent needs to
 * call each tool correctly and points at a fetch_docs topic for the rest, so a
 * pointer to a topic fetch_docs cannot serve would leave that rest unreachable.
 * The rules an agent needs on its first call stay in tools/list, and are held
 * to it at the bottom of this file.
 */

import '../helpers/next-request-polyfill'
import fs from 'fs'
import path from 'path'
import { NextRequest, NextResponse } from 'next/server'

jest.mock('@/lib/mcp/guard', () => ({
  mcpGuard: jest.fn(async () => ({
    auth: { success: true, projectId: 'p1', userId: 'u1', keyId: 'k1', readOnly: true },
  })),
  recordMcpCall: jest.fn(),
  refuseIfReadOnly: jest.fn(() => NextResponse.json({ ok: false, code: 'READ_ONLY_KEY' }, { status: 403 })),
}))

import { POST as toolPost } from '@/app/api/mcp/tool/route'
import { BRAIN_TOOLS } from '@/lib/ai/brain/tools'
import { AGENT_DOC_TOPICS, agentDocPublicPath, resolveDocTopic } from '@/lib/mcp/agent-docs'
import { buildCatalog, buildDispatchable } from '@/lib/mcp/catalog'
import { DOMAIN_TOOLS, domainDocsTopic } from '@/lib/mcp/domains'

const POINTER = /fetch_docs \{ topic: "([a-z0-9-]+)" \}/g

/** The topics a description sends the agent to. */
function topicsNamed(description: string): string[] {
  return [...description.matchAll(POINTER)].map((m) => m[1])
}

const catalogs = [['a read-write key', buildCatalog()], ['a read-only key', buildCatalog({ readOnly: true })]] as const

describe.each(catalogs)('what %s is offered', (_who, catalog) => {
  // fetch_docs is the docs: its topic argument lists every topic instead
  // (tests/unit/agent-docs-conformance.spec.ts).
  const tools = catalog.filter((t) => t.name !== 'fetch_docs')

  it('names a docs topic in every tool description', () => {
    expect(tools.filter((t) => topicsNamed(t.description).length === 0).map((t) => t.name)).toEqual([])
  })

  it('names only topics that exist, by their id', () => {
    const wrong = tools.flatMap((t) => topicsNamed(t.description)
      .filter((id) => resolveDocTopic(id)?.id !== id)
      .map((id) => `${t.name} -> ${id}`))
    expect(wrong).toEqual([])
  })

  it('sends each section tool to its own topic', () => {
    const sections = tools.filter((t) => DOMAIN_TOOLS.some((d) => d.name === t.name))
    expect(sections.length).toBeGreaterThan(5)
    for (const t of sections) expect({ tool: t.name, topics: topicsNamed(t.description) }).toEqual({ tool: t.name, topics: [domainDocsTopic(t.name)] })
  })
})

describe('fetch_docs serves every topic a description names', () => {
  const named = [...new Set(catalogs.flatMap(([, catalog]) => catalog.flatMap((t) => topicsNamed(t.description))))].sort()

  it('finds the topics it checks', () => {
    expect(named.length).toBeGreaterThan(8)
  })

  it.each(named.map((id) => [id] as const))('%s', async (id) => {
    const res = await toolPost(new NextRequest('https://backenly.test/api/mcp/tool', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'mcp_live_test_key' },
      body: JSON.stringify({ tool: 'fetch_docs', args: { topic: id } }),
    }))
    expect(res.status).toBe(200)
    const data = (await res.json() as any).data
    expect(data.topic).toBe(id)
    expect(data.markdown).toBe(fs.readFileSync(path.join(process.cwd(), 'public', agentDocPublicPath(id)), 'utf8'))
  })

  it('every topic the registry has is one fetch_docs can be asked for by its id', () => {
    for (const t of AGENT_DOC_TOPICS) expect(resolveDocTopic(t.id)?.id).toBe(t.id)
  })
})

/**
 * What a shorter tools/list must still say on the first call: the refusals an
 * agent would otherwise hit, the arguments it must send, what waits for a
 * person or cannot be undone, and what a read-only key may do. Each line is a
 * failure an agent met when the text was missing. And what it must not say: the
 * name of a tool the host does not offer, which an agent cannot call.
 */
describe('keeps the first-call rules in tools/list', () => {
  const rw = new Map(buildCatalog().map((t) => [t.name, t]))
  const ro = new Map(buildCatalog({ readOnly: true }).map((t) => [t.name, t]))
  const text = (t: { description: string; inputSchema: { properties: Record<string, unknown> } }) =>
    [t.description, ...Object.values(t.inputSchema.properties).map((p) => String((p as { description?: string }).description ?? ''))].join('\n')

  it.each([
    ['run_query', /catalogs[\s\S]{0,80}refused/i, 'the system catalogs are refused'],
    ['run_query', /apply_migration/, 'where schema writes go'],
    ['run_query', /db_insert/, 'where row writes go'],
    ['apply_migration', /BRANCH_REQUIRED/, 'protected production refuses it without a branch'],
    ['apply_migration', /awaiting_approval/, 'drops and retypes wait for a person'],
    ['apply_migration', /`applied`[\s\S]*do not replay/i, 'what a failed migration left applied'],
    ['apply_migration', /"createdAt"/, 'the columns every table gets'],
    ['db_update', /empty[\s\S]{0,40}refused/i, 'no table-wide update'],
    ['db_delete', /empty[\s\S]{0,40}refused/i, 'no table-wide delete'],
    ['set_rls', /CHECK/, 'when a policy needs a CHECK'],
    ['set_rls', /using`? alone lets a caller/i, 'the UPDATE rule needs both halves'],
    ['get_table_schema', /editableUsing/, 'which policy text set_rls accepts back'],
    ['branch', /no approval,? (and )?no undo/i, 'discard cannot be undone'],
    ['branch', /\[waits for approval\]/, 'a merge waits for a person'],
    ['backend_chat', /AI credits/, 'what it costs'],
    ['backend_chat', /`next`/, 'how a running or stopped request carries on'],
    ['check_approval', /only a person approves/i, 'an agent cannot approve'],
    ['connect', /SERVICE_KEY_REQUIRES_HUMAN/, 'a service-role key is refused'],
    ['connect', /never (uses )?your MCP key/i, 'which key an app uses'],
    ['webhooks', /returned once/, 'the signing secret is shown once'],
    ['functions', /AI credits/, 'what create and schedule cost'],
  ] as const)('%s: %s (%s)', (name, rule) => {
    expect(text(rw.get(name)! as any)).toMatch(rule)
  })

  it('names no tool a read-write key is not offered, except as an action of a section tool', () => {
    // The row tools said "as the owner (see db_query)", and the webhooks and
    // deploy arguments said where an id comes from by naming list_webhooks or
    // list_schema_changes: tools that tools/list does not offer.
    const tools = new Set([...buildDispatchable().map((t) => t.name), ...BRAIN_TOOLS.map((t) => t.function.name)])
    const offered = new Set([...rw.keys(), ...DOMAIN_TOOLS.filter((d) => rw.has(d.name)).flatMap((d) => Object.keys(d.actions))])
    const mentions = [...rw.values()].flatMap((t) => [...text(t as any).matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)]
      .map((m) => ({ tool: t.name, name: m[0] }))
      .filter(({ name }) => tools.has(name)))
    // It reads real mentions: run_query names apply_migration, for one.
    expect(mentions.length).toBeGreaterThan(5)
    const notOffered = mentions.filter(({ name }) => !offered.has(name)).map(({ tool, name }) => `${tool} -> ${name}`)
    expect([...new Set(notOffered)]).toEqual([])
  })

  it('tells a read-only key that each section tool narrowed for it only reads', () => {
    const narrowed = DOMAIN_TOOLS.filter((d) => ro.has(d.name) && rw.get(d.name)!.annotations!.readOnlyHint === false)
    expect(narrowed.length).toBeGreaterThan(5)
    for (const d of narrowed) {
      expect({ tool: d.name, says: /read-only: every action here only reads/.test(ro.get(d.name)!.description) })
        .toEqual({ tool: d.name, says: true })
    }
  })
})
