/**
 * The /agents pages must describe the setup that actually ships.
 *
 * Each page is what a developer copies from to connect one agent, so every
 * command, config block, file path, count and error code on it is a promise.
 * Each already has a source of truth, and the pages are held to it here:
 *
 *   commands           public/docs/agents/client-setup.md, the file agents read
 *   Cursor blocks      components/connect/AgentInstallGuide.tsx (the Connect page)
 *   key-free setup     packages/mcp-server/src/init.ts + config.ts
 *   CLI behaviour      packages/cli/bin/backenly.mjs, run as a child process
 *   tool counts        lib/mcp/catalog.ts buildCatalog()
 *   approvals          lib/mcp/domains.ts needsApproval()
 *   connect brief      lib/mcp/protocol/shared.ts buildMcpInstructions()
 *   error codes        the modules that return them
 *   structured data    the FAQ and trail the pages render
 */

jest.setTimeout(60_000)

import '@/tests/helpers/real-web-standard'
import { RESOURCE_ORDER } from '@/lib/changes/resources/core'

// `jose` ships ESM-only and jest cannot parse it. No request below carries a
// token, so the JWT branch never runs (as in seo-crawl-surface.spec.ts).
jest.mock('jose', () => ({ jwtVerify: jest.fn(async () => ({ payload: {} })) }))

import http from 'http'
import { AddressInfo } from 'net'
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildCatalog } from '@/lib/mcp/catalog'
import { DOMAIN_TOOLS, needsApproval } from '@/lib/mcp/domains'
import { buildMcpInstructions } from '@/lib/mcp/protocol/shared'
import { DOCS_MAX_CHARS } from '@/lib/mcp/docs-limit'
import { NPX_ARGS, remoteUrl } from '@/components/connect/AgentInstallGuide'
import { ADVERTISED_TOOL_COUNT, INSTALLS, MCP_ENDPOINT, READ_ONLY_TOOL_COUNT } from '@/app/mcp/data'
import { AGENTS, AGENT_SLUGS, CLAUDE_CODE, CLI_FALLBACK, CURSOR } from '@/app/agents/data'
import { agentStructuredData, agentTrail } from '@/app/agents/shared'
import { NextRequest } from 'next/server'
import { middleware } from '@/middleware'
import sitemap from '@/app/sitemap'

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8')

const CLIENT_SETUP = read('public/docs/agents/client-setup.md')
const SKILL = read('public/skill.md')
const LLMS = read('public/llms.txt')
const INSTALL_GUIDE = read('components/connect/AgentInstallGuide.tsx')
const INIT = read('packages/mcp-server/src/init.ts')
const STDIO_CONFIG = read('packages/mcp-server/src/config.ts')
const STDIO_CLI = read('packages/mcp-server/src/cli.ts')
const STDIO_PACKAGE = JSON.parse(read('packages/mcp-server/package.json')) as { engines: { node: string } }
const CHANGELOG = read('packages/mcp-server/CHANGELOG.md')
const DOCS_LIMIT = read('lib/mcp/docs-limit.ts')
const CONSENT = read('app/mcp/authorize/page.tsx')
const MCP_AUTH = read('lib/mcp/auth.ts')

const CLI = path.join(process.cwd(), 'packages', 'cli', 'bin', 'backenly.mjs')

/** Every string a page renders, for "does the page say this" checks. */
const text = (page: object) => JSON.stringify(page)

type McpJson = { mcpServers: { backenly: Record<string, unknown> } }
const backenlyEntry = (code: string) => (JSON.parse(code) as McpJson).mcpServers.backenly

// ── Claude Code ───────────────────────────────────────────────────────────────

describe('the Claude Code page gives the commands agents are told', () => {
  it.each(CLAUDE_CODE.installs.map((i) => [i.id, i.code]))('%s appears verbatim in client-setup.md', (_id, code) => {
    expect(CLIENT_SETUP).toContain(code)
  })

  it('uses the same three commands as /mcp, in the same order', () => {
    const fromMcp = INSTALLS.filter((i) => i.client === 'Claude Code').map((i) => i.code)
    expect(CLAUDE_CODE.installs.map((i) => i.code)).toEqual(fromMcp)
    for (const install of CLAUDE_CODE.installs) expect(install.code).toContain('claude mcp add')
  })

  it('points the remote commands at the live endpoint', () => {
    expect(MCP_ENDPOINT).toBe('https://backenly.com/api/mcp')
    const remote = CLAUDE_CODE.installs.filter((i) => i.code.includes('--transport http'))
    expect(remote).toHaveLength(2)
    for (const install of remote) expect(install.code).toContain(MCP_ENDPOINT)
  })

  it('describes the browser sign-in as client-setup.md and the consent screen do', () => {
    const oauth = CLAUDE_CODE.installs.find((i) => i.id === 'claude-code-oauth')!
    expect(oauth.code).not.toContain('x-api-key')
    expect(CLIENT_SETUP).toContain('run `/mcp`, pick `backenly` and choose Authenticate')
    // "Read-only access starts checked": the consent screen's box is on by default.
    expect(oauth.body).toContain('Read-only access starts checked')
    expect(CONSENT).toMatch(/name="read_only"\s+defaultChecked/)
    expect(CONSENT).toContain('Read-only access')
  })

  it('states the stdio package’s Node requirement and its project check', () => {
    expect(STDIO_PACKAGE.engines.node).toBe('>=20.0.0')
    expect(text(CLAUDE_CODE)).toContain('Node.js 20 or later')
    expect(STDIO_CLI).toContain('verified against the key at startup')
  })

  it('gives the key-free command that `init` prints, after saving the key user-only', () => {
    expect(INIT).toContain(`write('    ${CLAUDE_CODE.keyFreeCommand}\\n')`)
    expect(CLAUDE_CODE.keyFree).toContain(CLAUDE_CODE.keyFreeCommand)
    expect(STDIO_CONFIG).toContain("join(homedir(), '.backenly', 'mcp.json')")
    expect(INIT).toContain('mode: 0o600')
    expect(CLAUDE_CODE.keyFree).toContain('~/.backenly/mcp.json')
  })

  it('says how the next conversation picks the tools up, as the agent docs do', () => {
    expect(SKILL).toContain('a new tab in the Claude Code VS Code extension, or `/exit` then `claude --continue` in a terminal')
    expect(CLIENT_SETUP).toContain('`/mcp` lists `backenly` when it worked')
    expect(CLAUDE_CODE.session.next.body).toContain('`claude --continue`')
    // The prompt is the Connect doc's own.
    const connectDoc = read('app/docs/content.ts')
    expect(connectDoc).toContain(CLAUDE_CODE.session.next.prompt)
  })

  it('names the troubleshooting codes the MCP auth really returns', () => {
    const answer = CLAUDE_CODE.faq.find((f) => /does not show/.test(f.q))!.a
    expect(answer).toContain('INVALID_TOKEN')
    expect(answer).toContain('INVALID_KEY')
    // A Bearer header is taken as an OAuth token, so an mcp_live_ key there is INVALID_TOKEN.
    expect(MCP_AUTH).toContain("authHeader?.startsWith('Bearer ')")
    expect(MCP_AUTH).toContain("code: 'INVALID_TOKEN'")
    expect(MCP_AUTH).toContain("code: 'INVALID_KEY'")
  })
})

describe('what Claude Code is told on connect, by the skill and by fetch_docs', () => {
  it('restates the instructions the server sends on connect', () => {
    const brief = buildMcpInstructions('demo', ADVERTISED_TOOL_COUNT)
    expect(brief).toContain('ON YOUR FIRST REPLY of this session, briefly tell the user Backenly is connected to\n"demo"')
    expect(brief).toMatch(/call read_backend_state before\s+proposing or making changes/)
    expect(brief).toContain('the runtime API refuses it. Never\n  put it in app code')
    expect(CHANGELOG).toContain("Hosts that surface them (Claude Code, etc.) inject the brief into the agent's context")
  })

  it('quotes the fetch_docs ceiling and the Claude Code limit it was set for', () => {
    expect(DOCS_MAX_CHARS).toBe(40_000)
    expect(DOCS_LIMIT).toContain("Claude Code's default 25k-token cap on one MCP tool result")
    expect(LLMS.length).toBeLessThanOrEqual(DOCS_MAX_CHARS)
    const cell = CLAUDE_CODE.context.find((c) => c.body.includes('fetch_docs'))!
    expect(cell.body).toContain('40,000 characters')
    expect(cell.body).toContain('25,000 tokens')
  })
})

// ── Cursor ────────────────────────────────────────────────────────────────────

describe('the Cursor page gives the blocks the Connect page prints', () => {
  const ORIGINAL_ENV = process.env.NEXT_PUBLIC_APP_URL

  beforeEach(() => {
    ;(global as any).window = { location: { origin: 'https://backenly.com' } }
  })
  afterEach(() => {
    delete (global as any).window
    if (ORIGINAL_ENV === undefined) delete process.env.NEXT_PUBLIC_APP_URL
    else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_ENV
  })

  it('remote: the url and the key header, and no type field', () => {
    const remote = backenlyEntry(CURSOR.configs.find((c) => c.id === 'remote')!.code)
    expect(remote).toEqual({ url: remoteUrl(), headers: { 'x-api-key': '<scoped-key>' } })
    expect(remoteUrl()).toBe(MCP_ENDPOINT)
    expect(INSTALL_GUIDE).toContain('Cursor infers the transport from the url')
    expect(INSTALL_GUIDE).toMatch(/function cursorRemoteJson[\s\S]*?url: remoteUrl\(\), headers: \{ 'x-api-key': key \}/)
  })

  it('local: npx with the Connect page’s own arguments, and no type field', () => {
    const local = backenlyEntry(CURSOR.configs.find((c) => c.id === 'local')!.code)
    expect(local).toEqual({ command: 'npx', args: NPX_ARGS('<id>', '<scoped-key>') })
    expect(INSTALL_GUIDE).toMatch(/id: 'cursor', name: 'Cursor',\s+local: \{ kind: 'json', next: CURSOR_NEXT, build: stdioJson \}/)
  })

  it('local, self-hosted: the args end with --endpoint and the instance address', () => {
    ;(global as any).window = { location: { origin: 'https://backend.acme.dev' } }
    expect(NPX_ARGS('<id>', '<scoped-key>').slice(-2)).toEqual(['--endpoint', 'https://backend.acme.dev'])
    expect(text(CURSOR)).toContain('the args end with `--endpoint`')
  })

  it('puts the block in the user config and reloads the window, as the Connect page says', () => {
    expect(CLIENT_SETUP).toContain("`~/.cursor/mcp.json` for Cursor (the user config, not the project's, so the key is never committed beside the app)")
    expect(INSTALL_GUIDE).toContain('Paste into <code>~/.cursor/mcp.json</code>, not the project&apos;s')
    expect(INSTALL_GUIDE).toContain('Then reload the window.')
    expect(CURSOR.configNote).toContain('reload the Cursor window')
  })

  it('gives the key-free block that `init` prints', () => {
    expect(backenlyEntry(CURSOR.placement.find((c) => c.code)!.code!)).toEqual({
      command: 'npx',
      args: ['-y', '@backenly/mcp-server'],
    })
    expect(INIT).toContain(`'          "command": "npx",'`)
    expect(INIT).toContain(`'          "args": ["-y", "@backenly/mcp-server"]'`)
    expect(INIT).toContain('We deliberately do NOT embed the user\'s key in the snippet')
  })

  it('says what Cline needs that Cursor does not, as client-setup.md does', () => {
    const answer = CURSOR.faq.find((f) => /streamableHttp/.test(f.q))!.a
    expect(answer).toContain('405')
    expect(CLIENT_SETUP).toContain('Its remote entry must set `"type": "streamableHttp"`, or it falls back to SSE and the endpoint answers 405.')
  })
})

// ── The CLI both pages use ────────────────────────────────────────────────────

describe('the CLI does what the pages say', () => {
  let server: http.Server
  let base = ''
  const SKILL_BODY = '# Working with Backenly (test body)\n'

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/skill.md') {
        res.writeHead(200, { 'content-type': 'text/markdown' })
        res.end(SKILL_BODY)
        return
      }
      if (req.url?.startsWith('/api/cli/overview')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            project: { id: 'proj-1', name: 'Demo' },
            schema: { tableCount: 0 },
            counts: { endpoints: 0, functions: 0 },
          }),
        )
        return
      }
      res.writeHead(404).end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  function cli(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [CLI, ...args, '--url', base],
        { cwd, env: { ...process.env, BACKENLY_API_KEY: '', BACKENLY_API_URL: '' } },
        (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr }),
      )
    })
  }

  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pages-'))
  /** The page's command, minus the npx launcher, as argv for the local CLI. */
  const argvOf = (command: string) => command.replace('npx -y @backenly/cli@latest ', '').split(' ')

  it('install-skill --agent claude writes the Claude Code skill the page names', async () => {
    const cell = CLAUDE_CODE.context.find((c) => c.code?.includes('install-skill'))!
    expect(cell.code).toBe('npx -y @backenly/cli@latest install-skill --agent claude')
    const dir = tmp()
    const run = await cli(argvOf(cell.code!), dir)
    expect(run.code).toBe(0)
    const file = path.join(dir, '.claude', 'skills', 'backenly', 'SKILL.md')
    expect(cell.body).toContain('`.claude/skills/backenly/SKILL.md`')
    const written = fs.readFileSync(file, 'utf8')
    expect(written).toMatch(/^---\nname: backenly\ndescription: /)
    expect(written.endsWith(SKILL_BODY)).toBe(true)
    expect(fs.existsSync(path.join(dir, '.cursor'))).toBe(false)
  })

  it('install-skill --agent cursor writes an always-applied rule the page names', async () => {
    expect(CURSOR.rules.code).toBe('npx -y @backenly/cli@latest install-skill --agent cursor')
    const dir = tmp()
    const run = await cli(argvOf(CURSOR.rules.code), dir)
    expect(run.code).toBe(0)
    expect(CURSOR.rules.body).toContain('`.cursor/rules/backenly.mdc`')
    expect(CURSOR.rules.body).toContain('`alwaysApply: true`')
    const written = fs.readFileSync(path.join(dir, '.cursor', 'rules', 'backenly.mdc'), 'utf8')
    expect(written).toMatch(/^---\ndescription: .+\nalwaysApply: true\n---\n/)
    expect(written.endsWith(SKILL_BODY)).toBe(true)
    expect(fs.existsSync(path.join(dir, '.claude'))).toBe(false)
  })

  it('the skill both pages describe covers what they say it covers', () => {
    for (const heading of ['## The tools', '## The workflow that works', '## Errors']) expect(SKILL).toContain(heading)
    expect(SKILL).toContain('**The project key is never your MCP key.**')
  })

  it('link stores the key, and gitignores it only when the repository has a .gitignore', async () => {
    const link = CLI_FALLBACK.split('\n')[0]
    const withIgnore = tmp()
    fs.writeFileSync(path.join(withIgnore, '.gitignore'), 'node_modules\n')
    const args = argvOf(link).map((a) => (a === '<id>' ? 'proj-1' : a === '<scoped-key>' ? 'mcp_live_k' : a))
    expect((await cli(args, withIgnore)).code).toBe(0)
    expect(JSON.parse(fs.readFileSync(path.join(withIgnore, '.backenly', 'config.json'), 'utf8')).key).toBe('mcp_live_k')
    expect(fs.readFileSync(path.join(withIgnore, '.gitignore'), 'utf8')).toMatch(/^\.backenly\/$/m)

    const without = tmp()
    expect((await cli(args, without)).code).toBe(0)
    expect(fs.existsSync(path.join(without, '.gitignore'))).toBe(false)

    // A key from another project is refused before anything is stored.
    const other = tmp()
    const wrong = args.map((a) => (a === 'proj-1' ? 'proj-2' : a))
    expect((await cli(wrong, other)).code).toBe(1)
    expect(fs.existsSync(path.join(other, '.backenly'))).toBe(false)

    expect(CLAUDE_CODE.session.now.note).toContain('when the repository has one')
    expect(CURSOR.fallback.note).toContain('if the repository has a `.gitignore`')
  })

  it.each(CLI_FALLBACK.split('\n').map((line) => [line]))('"%s" is a line client-setup.md gives agents', (line) => {
    expect(CLIENT_SETUP).toContain(line)
  })
})

// ── Facts both pages state ────────────────────────────────────────────────────

describe('the facts both pages state', () => {
  it('count the tools a read-write and a read-only key see, from the catalog', () => {
    expect(ADVERTISED_TOOL_COUNT).toBe(buildCatalog().length)
    expect(READ_ONLY_TOOL_COUNT).toBe(buildCatalog({ readOnly: true }).length)
    const phrase = `${READ_ONLY_TOOL_COUNT} tools instead of ${ADVERTISED_TOOL_COUNT}`
    expect(CLAUDE_CODE.access.some((c) => c.body.includes(phrase))).toBe(true)
    expect(CURSOR.faq.some((f) => f.a.includes(phrase))).toBe(true)
  })

  it('name error codes the code really returns', () => {
    expect(read('lib/security/key-placement.ts')).toContain("export const MCP_KEY_IN_APP = 'MCP_KEY_IN_APP'")
    expect(read('lib/mcp/guard.ts')).toContain("code: 'READ_ONLY_KEY'")
    expect(read('lib/mcp/migration-parser.ts')).toContain("'DESTRUCTIVE_REFUSED'")
    expect(text(CLAUDE_CODE)).toContain('MCP_KEY_IN_APP')
    expect(text(CURSOR)).toContain('MCP_KEY_IN_APP')
    expect(text(CLAUDE_CODE)).toContain('DESTRUCTIVE_REFUSED')
  })

  it('say deploying, rolling back, revoking a key and deleting files or functions wait for a person', () => {
    const gated = (tool: string, action: string) => {
      const domain = DOMAIN_TOOLS.find((d) => d.name === tool)!
      return needsApproval(domain.actions[action].tool)
    }
    expect(gated('deploy', 'deploy')).toBe(true)
    expect(gated('deploy', 'rollback')).toBe(true)
    expect(gated('connect', 'revoke_api_key')).toBe(true)
    expect(gated('storage', 'delete_file')).toBe(true)
    expect(gated('functions', 'delete')).toBe(true)
    // whoami, which both pages point at, is an ordinary read.
    expect(gated('connect', 'whoami')).toBe(false)
  })

  it('never offer the server as a client for an arbitrary PostgreSQL database', () => {
    for (const slug of AGENT_SLUGS) {
      const answer = AGENTS[slug].faq.find((f) => /existing PostgreSQL database/.test(f.q))!.a
      expect(answer.startsWith('No.')).toBe(true)
      expect(answer).toContain('Backenly project')
    }
  })

  it('link to the setup guide, /mcp, the safe-changes guide and each other', () => {
    for (const slug of AGENT_SLUGS) {
      const hrefs = AGENTS[slug].next.map((n) => n.href)
      expect(hrefs).toEqual(expect.arrayContaining(['/docs/connect', '/mcp', '/guides/safe-ai-database-changes']))
      for (const other of AGENT_SLUGS.filter((s) => s !== slug)) expect(hrefs).toContain(`/agents/${other}`)
      for (const item of AGENTS[slug].next) expect(item.meta && item.body).toBeTruthy()
    }
  })
})

// ── Structured data ───────────────────────────────────────────────────────────

describe.each(AGENT_SLUGS.map((slug) => [slug]))('/agents/%s structured data', (slug) => {
  const page = AGENTS[slug]
  const nodes = agentStructuredData(page)['@graph'] as Array<Record<string, any>>

  it('mirrors the FAQ the page renders, question for question', () => {
    const faq = nodes.find((n) => n['@type'] === 'FAQPage')!
    expect(faq.mainEntity).toEqual(
      page.faq.map((item) => ({ '@type': 'Question', name: item.q, acceptedAnswer: { '@type': 'Answer', text: item.a } })),
    )
  })

  it('mirrors the hero trail, with a URL for every crumb', () => {
    const crumbs = nodes.find((n) => n['@type'] === 'BreadcrumbList')!.itemListElement as Array<Record<string, any>>
    expect(crumbs.map((c) => c.name)).toEqual(agentTrail(page).map((c) => c.label))
    expect(crumbs.map((c) => c.item)).toEqual([
      'https://backenly.com',
      'https://backenly.com/mcp',
      `https://backenly.com/agents/${slug}`,
    ])
  })

  it('headlines the article with the page’s own title', () => {
    expect(nodes.find((n) => n['@type'] === 'TechArticle')!.headline).toBe(page.title)
  })
})

// ── Reachable by anyone ───────────────────────────────────────────────────────

describe('the agent pages are public', () => {
  const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL
  beforeAll(() => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://backenly.com'
  })
  afterAll(() => {
    process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL
  })

  const answer = async (p: string) => {
    const res = await middleware(new NextRequest(`https://backenly.com${p}`, { headers: { host: 'backenly.com' } }))
    return { location: res?.headers.get('location') ?? null, rewrite: res?.headers.get('x-middleware-rewrite') ?? null }
  }

  // Served on Cloud, and sent to /app off it, exactly as /mcp and /guides are;
  // never the 404 page an unlisted path gets.
  it.each(AGENT_SLUGS.map((slug) => [`/agents/${slug}`]))('%s is answered as /mcp is, never with the 404 page', async (p) => {
    const got = await answer(p)
    expect(got.rewrite ?? '').not.toContain('/_not-a-page')
    expect(got).toEqual(await answer('/mcp'))
    expect(got).toEqual(await answer('/guides/safe-ai-database-changes'))
  })

  it('lists every agent page in the sitemap', () => {
    const urls = sitemap().map((e) => e.url)
    for (const slug of AGENT_SLUGS) expect(urls).toContain(`https://backenly.com/agents/${slug}`)
  })

  it.each(['claude-code', 'cursor'] as const)('%s: the undo answer names every part the one History records', (slug) => {
    const words: Record<string, string> = { env: 'environment variables' }
    const answer = AGENTS[slug].faq.find((f) => /undo/i.test(f.q))!.a
    expect(answer).toMatch(/the schema/)
    for (const part of RESOURCE_ORDER) expect([part, answer.includes(words[part] ?? part)]).toEqual([part, true])
    expect(answer).toMatch(/only you can approve/)
  })
})
