/**
 * The agent docs say only what the code does.
 *
 * public/llms.txt is an index and each topic is its own file under
 * public/docs/agents (lib/mcp/agent-docs.ts). Agents act on every sentence in
 * them, and they drifted every time they were edited by hand: llms.txt promised
 * `ctx.integrations.resend.send` when Resend has only `request`, said every
 * provider has `request` when three do not, and said `functions` could not
 * take code you wrote after it could. So each kind of claim is held to its
 * source here:
 *
 *   • the files: every topic has one, the index links each, nothing is orphaned
 *   • the action tables: byte for byte what lib/mcp/domains.ts renders
 *   • inline calls (`tool { arg }`): the tool, the action and every argument exist
 *   • `domain` `action` references: the action is that domain's
 *   • ctx.integrations: the provider and the method are in the registry
 *   • read-only, header and approval claims: against the catalog and the runtime
 *   • error codes: each one is returned somewhere in the code
 *   • fetch_docs: every topic and alias routes to its file
 *   • what the docs must no longer carry: pricing, positioning, restart advice
 *
 * Tool names themselves are held in tests/unit/docs-tool-catalog-conformance.spec.ts.
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
import { AGENT_DOCS_URL, AGENT_DOC_TOPICS, agentDocPublicPath, resolveDocTopic } from '@/lib/mcp/agent-docs'
import { generatedBlocks, readGeneratedBlock } from '@/lib/mcp/agent-docs-render'
import { BRANCH_ACTIONS, buildCatalog, buildDispatchable } from '@/lib/mcp/catalog'
import { DOMAIN_TOOLS, actionRequires, domainInputSchema, getDomainTool } from '@/lib/mcp/domains'
import { BRAIN_TOOLS } from '@/lib/ai/brain/tools'
import { DOCS_MAX_CHARS } from '@/lib/mcp/docs-limit'
import { allProviderIds, getProviderSpec, resolveProviderId } from '@/lib/services/ai-functions/integration-registry'

const ROOT = process.cwd()
const PUBLIC = path.join(ROOT, 'public')
const read = (rel: string) => fs.readFileSync(path.join(PUBLIC, rel), 'utf8')

const INDEX = read('llms.txt')
const TOPIC_DIR = path.join(PUBLIC, 'docs', 'agents')
const TOPIC_FILES = fs.readdirSync(TOPIC_DIR).sort()
const DOCS: Array<[string, string]> = [
  ['llms.txt', INDEX],
  ['skill.md', read('skill.md')],
  ...TOPIC_FILES.map((f) => [`docs/agents/${f}`, read(`docs/agents/${f}`)] as [string, string]),
]
const topicText = (id: string) => read(agentDocPublicPath(id))

/** Every match of `re` across the docs, with the file it is in. */
function across(re: RegExp): Array<{ file: string; m: RegExpMatchArray }> {
  return DOCS.flatMap(([file, text]) => [...text.matchAll(re)].map((m) => ({ file, m })))
}

describe('the topics and their files', () => {
  it('has one file per topic and no file without a topic', () => {
    expect(TOPIC_FILES).toEqual(AGENT_DOC_TOPICS.map((t) => `${t.id}.md`).sort())
  })

  it('covers every section tool', () => {
    const documented = new Set(AGENT_DOC_TOPICS.map((t) => t.domain).filter(Boolean))
    expect(DOMAIN_TOOLS.map((d) => d.name).filter((n) => !documented.has(n))).toEqual([])
  })

  it('gives each word one meaning: ids and aliases never collide', () => {
    const words = AGENT_DOC_TOPICS.flatMap((t) => [t.id, ...(t.aliases ?? [])].map((w) => w.toLowerCase().replace(/[\s_]+/g, '-')))
    expect(words.filter((w, i) => words.indexOf(w) !== i)).toEqual([])
  })

  it.each(AGENT_DOC_TOPICS.map((t) => [t.id, t] as const))('%s opens with its title and a link to the index', (_id, t) => {
    const text = topicText(t.id)
    expect(text.split('\n')[0]).toBe(`# ${t.title}`)
    expect(text).toContain('https://backenly.com/llms.txt')
  })

  it('lists every topic in the index, with its URL and the summary the registry holds', () => {
    for (const t of AGENT_DOC_TOPICS) {
      expect(INDEX).toContain(`- [${t.id}](${AGENT_DOCS_URL}/${t.id}.md): ${t.summary}`)
    }
  })

  it('links only to topics that exist', () => {
    const linked = across(/https:\/\/backenly\.com\/docs\/agents\/([a-z0-9-]+)\.md/g).map(({ file, m }) => `${file} -> ${m[1]}`)
    const known = new Set(AGENT_DOC_TOPICS.map((t) => t.id))
    expect(linked.filter((l) => !known.has(l.split(' -> ')[1]))).toEqual([])
  })

  it('keeps the index an index: well under one response', () => {
    expect(INDEX.length).toBeLessThanOrEqual(12_000)
    for (const [file, text] of DOCS) expect([file, text.length <= DOCS_MAX_CHARS]).toEqual([file, true])
  })
})

describe('the generated tables are what the code says', () => {
  it.each(generatedBlocks().map((b) => [`${b.file} ${b.name}`, b] as const))('%s', (_label, block) => {
    const committed = readGeneratedBlock(read(block.file), block.name)
    // On failure: npx tsx scripts/generate-agent-docs.ts, and commit the result.
    expect(committed).toBe(block.content)
  })
})

describe('every call the docs show is one that exists', () => {
  const dispatchable = new Map(buildDispatchable().map((t) => [t.name, t]))
  const brain = new Map(BRAIN_TOOLS.map((t) => [t.function.name, (t.function.parameters as any)?.properties ?? {}]))

  /** The arguments `name` accepts, or null when `name` is not a tool, section tool or action. */
  function acceptedArgs(name: string, action: string | null): Set<string> | null {
    const domain = getDomainTool(name)
    if (domain) {
      if (action && !domain.actions[action]) throw new Error(`${name} has no action "${action}"`)
      return new Set(Object.keys(domainInputSchema(domain).properties))
    }
    const tool = dispatchable.get(name)
    if (tool) return new Set(Object.keys((tool.inputSchema as any).properties ?? {}))
    if (brain.has(name)) return new Set(Object.keys(brain.get(name)))
    // A bare action name (`set_level { level }`): the arguments of its target.
    const targets = DOMAIN_TOOLS.flatMap((d) => (d.actions[name] ? [d.actions[name].tool] : []))
    if (targets.length) return new Set(targets.flatMap((t) => Object.keys(brain.get(t) ?? {})))
    return null
  }

  // Inline (`tool { … }`), and on a line of their own inside a code block. Code
  // blocks also hold JavaScript (`return { … }`), so there a line is a call only
  // when it starts with a tool, a section tool or an action.
  const isToolWord = (w: string) =>
    !!getDomainTool(w) || dispatchable.has(w) || brain.has(w) || DOMAIN_TOOLS.some((d) => d.actions[w])
  const calls = [
    ...across(/`([a-z_]+) \{ ([^`{}]*)\}`/g),
    ...across(/^([a-z_]+) \{ ([^{}\n]*)\}\s*$/gm).filter(({ m }) => isToolWord(m[1])),
  ]

  it('finds the calls it checks', () => {
    expect(calls.length).toBeGreaterThan(15)
  })

  it.each(calls.map(({ file, m }) => [`${file}: ${m[0]}`, m[1], m[2]] as const))('%s', (_label, name, body) => {
    const action = /\baction: "([a-z_]+)"/.exec(body)?.[1] ?? null
    const accepted = acceptedArgs(name, action)
    expect(accepted).not.toBeNull()
    const keys = body.split(',')
      .map((part) => /^\s*([A-Za-z_]\w*)\s*(?::|$)/.exec(part)?.[1])
      .filter((k): k is string => !!k)
    expect(keys.filter((k) => !accepted!.has(k))).toEqual([])
  })

  it('names only real actions when it writes a section tool and an action together', () => {
    const refs = across(/`([a-z_]+)` `([a-z_]+)`/g).filter(({ m }) => getDomainTool(m[1]))
    expect(refs.length).toBeGreaterThan(5)
    const wrong = refs.filter(({ m }) => !getDomainTool(m[1])!.actions[m[2]]).map(({ file, m }) => `${file}: ${m[0]}`)
    expect(wrong).toEqual([])
  })

  it('lists every branch action, and only those', () => {
    const text = topicText('branches')
    for (const a of Object.keys(BRANCH_ACTIONS)) expect(text).toContain(`\`${a}\``)
  })

  it('says what each action needs where the action table says it', () => {
    // A spot check of the generated column against the tool it came from.
    expect(actionRequires('deploy_function_code')).toEqual(['name', 'code', 'trigger'])
  })
})

describe('what the docs say functions can call', () => {
  it('names only providers the registry has', () => {
    const named = across(/ctx\.integrations\.([a-zA-Z]+)/g).map(({ file, m }) => [file, m[1]] as const)
    const unknown = named.filter(([, id]) => id !== 'isConnected' && !resolveProviderId(id))
    expect(unknown).toEqual([])
  })

  it('names only methods the provider has', () => {
    const calls = across(/ctx\.integrations\.([a-zA-Z]+)\.([a-zA-Z]+)/g)
    expect(calls.length).toBeGreaterThan(5)
    const wrong = calls
      .filter(({ m }) => {
        const spec = getProviderSpec(m[1]) ?? getProviderSpec(resolveProviderId(m[1]) ?? '')
        return !spec || !spec.methods.some((x) => x.name === m[2])
      })
      .map(({ file, m }) => `${file}: ${m[0]}`)
    expect(wrong).toEqual([])
  })

  it.each([
    ['stripe', ['stripe']],
    ['resend', ['email', 'resend']],
    ['openai', ['openai']],
    ['anthropic', ['anthropic']],
    ['posthog', ['posthog']],
  ] as const)('the %s topic lists every method the registry gives it', (topic, providers) => {
    const text = topicText(topic)
    for (const id of providers) {
      for (const method of getProviderSpec(id)!.methods) expect([id, method.name, text.includes(`${method.name}(`)]).toEqual([id, method.name, true])
    }
  })

  it('says which providers have no request(), and they really have none', () => {
    // integrations.md: "the email helper, PostHog and Twilio do not"
    for (const id of ['email', 'posthog', 'twilio']) {
      expect([id, getProviderSpec(id)!.methods.some((m) => m.name === 'request')]).toEqual([id, false])
    }
    expect(topicText('integrations')).toMatch(/the email helper, PostHog and Twilio do not/)
  })

  it('names every provider the runtime covers', () => {
    const text = topicText('integrations').toLowerCase()
    expect(allProviderIds().filter((id) => id !== 'email' && !text.includes(id))).toEqual([])
  })
})

describe('what the docs say about access', () => {
  const full = buildCatalog().map((t) => t.name)
  const readOnly = buildCatalog({ readOnly: true }).map((t) => t.name)

  it('states how many tools a read-only key sees', () => {
    expect(INDEX).toContain(`sees **${readOnly.length}** tools`)
  })

  it('withholds from a read-only key every write door it names as withheld', () => {
    const clause = /every write door \(([^)]*)\) is withheld/.exec(INDEX)
    expect(clause).not.toBeNull()
    const named = [...clause![1].matchAll(/`([a-z_]+)`/g)].map((m) => m[1])
    expect(named.length).toBeGreaterThan(3)
    for (const tool of named) expect([tool, full.includes(tool), readOnly.includes(tool)]).toEqual([tool, true, false])
    // "the row writes"
    for (const tool of ['db_insert', 'db_update', 'db_delete']) expect(readOnly).not.toContain(tool)
  })

  it('names the headers the runtime reads, as it reads them', () => {
    // The data API: the project key is x-api-key, the end-user is X-User-Token,
    // and Authorization: Bearer is read as an end-user JWT, not as a key.
    const source = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'dynamic.ts'), 'utf8')
    const fn = source.slice(source.indexOf('export async function getProjectIdFromAuth'))
    const body = fn.slice(0, fn.indexOf('\nexport '))
    expect(body).toContain("req.headers['x-api-key']")
    expect(body).toContain("req.headers['x-user-token']")
    expect(body.indexOf("req.headers['authorization']")).toBeGreaterThan(body.indexOf("req.headers['x-api-key']"))
    expect(body).toMatch(/Bearer [\s\S]*jwt|jwt[\s\S]*Bearer/i)
    const all = DOCS.map(([, t]) => t).join('\n')
    expect(all).toContain('x-api-key: <project key>')
    expect(all).toContain('X-User-Token: <end-user JWT>')
    // MCP: the key goes in x-api-key.
    expect(fs.readFileSync(path.join(ROOT, 'lib', 'mcp', 'auth.ts'), 'utf8')).toContain("'x-api-key'")
  })

  it.each(['sdk', 'cli', 'mcp-server'].map((p) => [p] as const))('the %s package README does not teach the project key as a Bearer token', (pkg) => {
    // The SDK's own README said "Authorization: Bearer <apiKey> identifies the
    // project" while the SDK sends x-api-key and the data API reads Bearer as an
    // end-user JWT.
    const readme = fs.readFileSync(path.join(ROOT, 'packages', pkg, 'README.md'), 'utf8')
    expect(readme).not.toMatch(/Authorization: Bearer <(?:apiKey|project key|scoped-key|key)>/)
  })

  it('names only approval statuses check_approval can report', () => {
    const source = fs.readFileSync(path.join(ROOT, 'lib', 'mcp', 'approvals.ts'), 'utf8')
    for (const status of ['executed', 'rejected', 'expired', 'failed', 'partial']) {
      expect([status, source.includes(`'${status}'`)]).toEqual([status, true])
      expect(topicText('autonomy')).toContain(`\`${status}\``)
    }
  })
})

describe('every error code in the docs is one the code returns', () => {
  function sources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) return e.name === 'node_modules' ? [] : sources(p)
      return /\.(ts|tsx)$/.test(e.name) ? [p] : []
    })
  }
  const code = ['lib', 'app', 'server'].flatMap((d) => sources(path.join(ROOT, d))).map((f) => fs.readFileSync(f, 'utf8')).join('\n')
  const table = topicText('errors').split('\n').filter((l) => l.startsWith('| `'))
  const codes = [...new Set(table.flatMap((row) => [...row.split('|')[1].matchAll(/`([A-Z_]+)`/g)].map((m) => m[1])))]

  it('finds the codes it checks', () => {
    expect(codes.length).toBeGreaterThan(15)
  })

  it.each(codes.map((c) => [c] as const))('%s', (c) => {
    expect(code.includes(`'${c}'`) || code.includes(`"${c}"`)).toBe(true)
  })
})

describe('fetch_docs serves the topic asked for', () => {
  async function fetchDocs(topic?: string) {
    const res = await toolPost(new NextRequest('https://backenly.test/api/mcp/tool', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'mcp_live_test_key' },
      body: JSON.stringify({ tool: 'fetch_docs', args: topic === undefined ? {} : { topic } }),
    }))
    expect(res.status).toBe(200)
    return (await res.json() as any).data
  }

  it('serves the index with no topic', async () => {
    const data = await fetchDocs()
    expect(data).toMatchObject({ topic: null, markdown: INDEX, topics: AGENT_DOC_TOPICS.map((t) => t.id) })
  })

  it.each(AGENT_DOC_TOPICS.map((t) => [t.id] as const))('serves %s as its own file', async (id) => {
    const data = await fetchDocs(id)
    expect(data.topic).toBe(id)
    expect(data.markdown).toBe(topicText(id))
  })

  it.each(AGENT_DOC_TOPICS.flatMap((t) => (t.aliases ?? []).map((a) => [a, t.id] as const)))('routes %s to %s', async (alias, id) => {
    expect((await fetchDocs(alias)).topic).toBe(id)
  })

  it('ignores case and separators', async () => {
    expect((await fetchDocs(' Client_Setup ')).topic).toBe('client-setup')
    expect(resolveDocTopic('DEPLOY_CODE')?.id).toBe('functions')
  })

  it('answers a topic that does not exist with the real list and the index, not a guess', async () => {
    const data = await fetchDocs('kubernetes')
    expect(data.topic).toBeNull()
    expect(data.unknownTopic).toBe('kubernetes')
    expect(data.markdown.startsWith('There is no docs topic "kubernetes". Topics: client-setup, database')).toBe(true)
    expect(data.markdown).toContain(INDEX)
  })

  it('tells the host every topic in the tool description', () => {
    const def = buildCatalog().find((t) => t.name === 'fetch_docs')!
    const description = (def.inputSchema as any).properties.topic.description as string
    for (const t of AGENT_DOC_TOPICS) expect(description).toContain(t.id)
  })
})

describe('what the docs no longer carry', () => {
  it.each(DOCS.map(([file, text]) => [file, text] as const))('%s: no pricing or positioning', (_file, text) => {
    expect(text).not.toMatch(/\$\d+\s*\/\s*month|\bper month\b|^#+\s*Pricing/im)
    expect(text).not.toMatch(/For LLMs recommending|What makes Backenly different/i)
    expect(text).not.toMatch(/\b(Firebase|Convex|InsForge|Appwrite|PocketBase)\b/)
    // The one legitimate mention: the SDK's supabase-js compatible entry point.
    expect(text.replace(/supabase-js|@backenly\/sdk\/supabase/g, '')).not.toMatch(/supabase/i)
  })

  it.each(DOCS.map(([file, text]) => [file, text] as const))('%s: no restart dead end', (_file, text) => {
    // The CLI works in the same conversation; telling an agent to reload its
    // editor stops the work for a step it does not need.
    expect(text).not.toMatch(/reload (the )?(vs ?code|window|editor)|Developer: Reload|restart (vs ?code|your (editor|ide)|the (editor|ide))|quit and reopen/i)
  })

  it('no longer says functions cannot take code you wrote', () => {
    for (const [, text] of DOCS) expect(text).not.toMatch(/does not accept code you wrote/)
  })
})
