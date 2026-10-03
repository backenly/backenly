/**
 * The published stdio server, driven by the official MCP client in both eras.
 *
 * Runs the BUILT entrypoint (dist/cli.js, what npm ships) as a child process
 * against a local stand-in for backenly.com. A 2025-era client opens with
 * `initialize`; a 2026-07-28 client opens with `server/discover` and carries a
 * `_meta` envelope on every request. The package serves both from one factory,
 * and every assertion below runs against both.
 *
 * What the stand-in answers is what Backenly's handlers answer, so the results
 * checked here are the results an agent gets: the server's own body, as text
 * and as structuredContent, with nothing added.
 *
 *   npm run build && npm test
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ENTRY = path.join(HERE, '..', 'dist', 'cli.js')
// Built so it cannot match the credential scanner: it is not a key.
const KEY = ['mcp', 'live', 'test', 'key', 'for', 'protocol'].join('_')

const TOOLS = ['backend_chat', 'read_backend_state', 'fetch_docs', 'apply_migration', 'db_query'].map((name) => ({
  name,
  tier: 'read',
  description: `${name} tool`,
  inputSchema: { type: 'object', properties: {} },
  annotations: { title: `Title of ${name}`, readOnlyHint: name === 'read_backend_state', destructiveHint: false, idempotentHint: false, openWorldHint: false },
}))

const MANIFEST = {
  ok: true,
  server: { name: 'backenly', version: '1.1.0', projectId: 'p1' },
  tools: TOOLS,
  instructions: 'Backenly is connected. The brief the remote endpoint serves.',
  resources: [
    { uri: 'backenly://state', name: 'Live backend state', description: 'State.', mimeType: 'application/json', tool: 'read_backend_state' },
    { uri: 'backenly://tables', name: 'Tables', description: 'Tables.', mimeType: 'application/json', tool: 'list_tables' },
  ],
}

/** What Backenly's handlers answer, by tool: [status, body]. */
const TOOL_ANSWERS = {
  read_backend_state: [200, { ok: true, summary: '2 tables', data: { tables: ['posts', 'users'] }, needsUser: false, timing: { ms: 3, heavy: false } }],
  list_tables: [200, { ok: true, summary: '1 table', data: [{ name: 'posts' }], needsUser: false }],
  db_query: [200, { ok: true, summary: 'Read 1 row(s) from posts', data: { rows: [{ id: 1 }], count: 1 }, needsUser: false }],
  apply_migration: [400, {
    ok: false,
    summary: 'The migration stopped at statement 2.',
    error: 'column "title" already exists',
    code: 'CONSTRAINT_CONFLICT',
    hint: 'Drop the ADD COLUMN for title; it is already there.',
    applied: [{ summary: 'Created table posts' }],
    data: null,
    needsUser: false,
  }],
  revoked_mid_session: [401, { ok: false, error: 'The API key is invalid or revoked.', code: 'INVALID_KEY' }],
}

const CHAT_ANSWER = {
  ok: true,
  summary: 'Dropping posts needs a human: parked for approval.',
  status: 'awaiting_approval',
  approval: { id: 'apr_1', status: 'pending', poll: 'check_approval', note: 'A project owner approves this in the dashboard.' },
  needsUser: true,
  timing: { ms: 12 },
}

function standIn({ manifestDown = false, healthStatus = 200 } = {}) {
  let down = manifestDown
  const calls = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
    calls.push({ method: req.method, url: req.url, body })
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.url === '/api/mcp/health') {
      if (healthStatus !== 200) return send(healthStatus, { ok: false, error: 'The API key is invalid or revoked.', code: 'INVALID_KEY' })
      return send(200, { ok: true, projectId: 'p1', project: { id: 'p1', name: 'Demo' }, toolCount: TOOLS.length })
    }
    if (req.url === '/api/mcp/manifest') {
      if (down) return send(503, { ok: false, error: 'warming up' })
      return send(200, MANIFEST)
    }
    if (req.url === '/api/mcp/tool') {
      const answer = TOOL_ANSWERS[body?.tool]
      if (!answer) return send(404, { ok: false, error: `Unknown MCP tool "${body?.tool}".`, code: 'UNKNOWN_TOOL' })
      return send(answer[0], answer[1])
    }
    if (req.url === '/api/mcp/chat') {
      if (!body?.message) return send(400, { ok: false, error: '`message` is required.', code: 'INVALID_INPUT' })
      return send(200, CHAT_ANSWER)
    }
    // /api/mcp/db/* among them: the package must not route anything else.
    send(410, { ok: false, error: `not served by this stand-in: ${req.url}` })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, calls, heal: () => { down = false }, base: `http://127.0.0.1:${server.address().port}` }),
    ),
  )
}

function childEnv(home) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
  return { ...env, HOME: home, USERPROFILE: home, BACKENLY_API_KEY: '', BACKENLY_MCP_CATALOG_RETRY_MS: '300' }
}

async function connect(base, era, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-mcp-home-'))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY, '--key', KEY, '--endpoint', base],
    env: childEnv(home),
    stderr: 'pipe',
  })
  const client = new Client(
    { name: 'protocol-test', version: '0' },
    { ...(era === 'modern' ? { versionNegotiation: { mode: 'auto' } } : {}), ...options },
  )
  await client.connect(transport)
  return {
    client,
    close: async () => {
      await client.close().catch(() => {})
      fs.rmSync(home, { recursive: true, force: true })
    },
  }
}

const lean = (body) => {
  const { timing: _t, events: _e, partialEvents: _p, ...rest } = body
  return rest
}

for (const era of ['legacy', 'modern']) {
  describe(`stdio, ${era} era`, () => {
    let stand
    let session

    before(async () => {
      assert.ok(fs.existsSync(ENTRY), `build the package first: ${ENTRY} is missing`)
      stand = await standIn()
      session = await connect(stand.base, era)
    })
    after(async () => {
      await session?.close()
      stand?.server.close()
    })

    test('negotiates the revision of its era', () => {
      assert.equal(session.client.getProtocolEra(), era)
      assert.equal(session.client.getNegotiatedProtocolVersion(), era === 'modern' ? '2026-07-28' : '2025-11-25')
    })

    test('serves the manifest instructions and advertises what it can do', () => {
      assert.equal(session.client.getInstructions(), MANIFEST.instructions)
      const caps = session.client.getServerCapabilities()
      assert.equal(caps.tools.listChanged, true)
      assert.ok(caps.resources)
    })

    test('lists the manifest tools with their titles and annotations', async () => {
      const { tools } = await session.client.listTools()
      assert.deepEqual(tools.map((t) => t.name), TOOLS.map((t) => t.name))
      const migration = tools.find((t) => t.name === 'apply_migration')
      assert.equal(migration.title, 'Title of apply_migration')
      assert.deepEqual(migration.annotations, TOOLS.find((t) => t.name === 'apply_migration').annotations)
    })

    test('a successful call is the handler body, as text and as structuredContent', async () => {
      const result = await session.client.callTool({ name: 'read_backend_state', arguments: {} })
      const expected = lean(TOOL_ANSWERS.read_backend_state[1])
      assert.ok(!result.isError)
      assert.deepEqual(result.structuredContent, expected)
      assert.equal(result.content.length, 1)
      assert.deepEqual(JSON.parse(result.content[0].text), expected)
    })

    test('a refusal carries its code, hint and what already landed', async () => {
      const result = await session.client.callTool({ name: 'apply_migration', arguments: { sql: 'x' } })
      assert.equal(result.isError, true)
      assert.equal(result.structuredContent.code, 'CONSTRAINT_CONFLICT')
      assert.equal(result.structuredContent.hint, TOOL_ANSWERS.apply_migration[1].hint)
      assert.deepEqual(result.structuredContent.applied, [{ summary: 'Created table posts' }])
      assert.match(result.content[1].text, /ALREADY APPLIED, do not repeat: Created table posts/)
    })

    test('db_* tools go to the tool handler, as they do over the remote endpoint', async () => {
      const before = stand.calls.length
      const result = await session.client.callTool({ name: 'db_query', arguments: { table: 'posts' } })
      assert.deepEqual(result.structuredContent, lean(TOOL_ANSWERS.db_query[1]))
      const made = stand.calls.slice(before).map((c) => c.url)
      assert.deepEqual(made, ['/api/mcp/tool'])
    })

    test('backend_chat keeps the approval object and invents nothing it was not sent', async () => {
      const result = await session.client.callTool({ name: 'backend_chat', arguments: { message: 'drop posts' } })
      assert.deepEqual(result.structuredContent, lean(CHAT_ANSWER))
      assert.equal(result.structuredContent.approval.id, 'apr_1')
      for (const absent of ['toolsRun', 'iterations', 'verified', 'applied', 'partial']) {
        assert.ok(!(absent in result.structuredContent), `${absent} was not sent and must stay absent`)
      }
    })

    test('a key revoked mid-session is a tool error the agent can read', async () => {
      const result = await session.client.callTool({ name: 'revoked_mid_session', arguments: {} })
      assert.equal(result.isError, true)
      assert.equal(result.structuredContent.code, 'INVALID_KEY')
    })

    test('an unknown tool is the server’s own refusal', async () => {
      const result = await session.client.callTool({ name: 'no_such_tool', arguments: {} })
      assert.equal(result.isError, true)
      assert.equal(result.structuredContent.code, 'UNKNOWN_TOOL')
    })

    test('lists the manifest resources and reads one through its tool', async () => {
      const { resources } = await session.client.listResources()
      assert.deepEqual(resources, MANIFEST.resources.map(({ tool: _tool, ...r }) => r))
      const read = await session.client.readResource({ uri: 'backenly://tables' })
      assert.equal(read.contents[0].mimeType, 'application/json')
      assert.deepEqual(JSON.parse(read.contents[0].text), lean(TOOL_ANSWERS.list_tables[1]))
    })

    test('an unknown resource is invalid params, naming the uri', async () => {
      await assert.rejects(session.client.readResource({ uri: 'backenly://nope' }), (err) => {
        assert.equal(err.code, -32602)
        assert.match(err.message, /backenly:\/\/nope/)
        return true
      })
    })
  })
}

for (const era of ['legacy', 'modern']) {
  test(`${era} era: a catalog that failed at boot loads and the host is told the list changed`, { timeout: 45_000 }, async () => {
    // Down until the degraded list has been checked, so the check cannot race the recovery.
    const stand = await standIn({ manifestDown: true })
    let changed
    const updated = new Promise((resolve) => { changed = resolve })
    const session = await connect(stand.base, era, {
      listChanged: { tools: { onChanged: (err, tools) => { if (!err && tools?.length === TOOLS.length) changed(tools) } } },
    })
    try {
      const degraded = await session.client.listTools()
      assert.deepEqual(degraded.tools.map((t) => t.name), ['backend_chat', 'read_backend_state', 'fetch_docs'])
      stand.heal()
      const tools = await Promise.race([
        updated,
        new Promise((_, reject) => setTimeout(() => reject(new Error('no list_changed within 20s')), 20_000)),
      ])
      assert.deepEqual(tools.map((t) => t.name), TOOLS.map((t) => t.name))
      // The catalog that loaded is the one served from now on.
      const full = await session.client.listTools()
      assert.deepEqual(full.tools.map((t) => t.name), TOOLS.map((t) => t.name))
    } finally {
      await session.close()
      stand.server.close()
    }
  })
}

// ── Raw wire checks the official client cannot make ─────────────────────────

function spawnRaw(base) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-mcp-home-'))
  const child = spawn(process.execPath, [ENTRY, '--key', KEY, '--endpoint', base], { env: childEnv(home) })
  const messages = []
  const stderr = []
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line) messages.push(JSON.parse(line))
    }
  })
  child.stderr.on('data', (c) => stderr.push(c.toString('utf8')))
  const write = (line) => child.stdin.write(line + '\n')
  const send = (msg) => write(JSON.stringify({ jsonrpc: '2.0', ...msg }))
  const waitFor = async (pred, ms = 10_000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const hit = messages.find(pred)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(`timed out; saw ${JSON.stringify(messages)}\nstderr:\n${stderr.join('')}`)
  }
  const done = () => {
    child.kill()
    fs.rmSync(home, { recursive: true, force: true })
  }
  return { child, send, write, waitFor, stderr, done }
}

const init = (id, protocolVersion) => ({
  id,
  method: 'initialize',
  params: { protocolVersion, capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
})

describe('raw stdio wire', () => {
  let stand
  before(async () => { stand = await standIn() })
  after(() => stand?.server.close())

  for (const version of ['2024-11-05', '2025-03-26', '2025-06-18']) {
    test(`an older client asking for ${version} is answered in ${version}`, async () => {
      const raw = spawnRaw(stand.base)
      try {
        raw.send(init(1, version))
        const answer = await raw.waitFor((m) => m.id === 1)
        assert.equal(answer.result.protocolVersion, version)
        assert.equal(answer.result.instructions, MANIFEST.instructions)
      } finally {
        raw.done()
      }
    })
  }

  test('a revision the server does not know is answered with one it does', async () => {
    const raw = spawnRaw(stand.base)
    try {
      raw.send(init(1, '2023-01-01'))
      const answer = await raw.waitFor((m) => m.id === 1)
      assert.equal(answer.result.protocolVersion, '2025-11-25')
    } finally {
      raw.done()
    }
  })

  test('a method the server does not serve is method-not-found, and the connection survives', async () => {
    const raw = spawnRaw(stand.base)
    try {
      raw.send(init(1, '2025-06-18'))
      await raw.waitFor((m) => m.id === 1)
      raw.send({ method: 'notifications/initialized' })
      raw.send({ id: 2, method: 'prompts/list' })
      const refused = await raw.waitFor((m) => m.id === 2)
      assert.equal(refused.error.code, -32601)
      raw.send({ id: 3, method: 'tools/list' })
      const listed = await raw.waitFor((m) => m.id === 3)
      assert.equal(listed.result.tools.length, TOOLS.length)
    } finally {
      raw.done()
    }
  })

  test('a malformed line does not take the connection down', async () => {
    const raw = spawnRaw(stand.base)
    try {
      raw.send(init(1, '2025-06-18'))
      await raw.waitFor((m) => m.id === 1)
      raw.send({ method: 'notifications/initialized' })
      raw.write('{this is not json')
      raw.send({ id: 2, method: 'tools/list' })
      const listed = await raw.waitFor((m) => m.id === 2)
      assert.equal(listed.result.tools.length, TOOLS.length)
    } finally {
      raw.done()
    }
  })
})

test('a key Backenly rejects at boot exits with the fix, before speaking MCP', { timeout: 20_000 }, async () => {
  const stand = await standIn({ healthStatus: 401 })
  const raw = spawnRaw(stand.base)
  try {
    const code = await new Promise((resolve) => raw.child.on('exit', resolve))
    assert.equal(code, 1)
    assert.match(raw.stderr.join(''), /rejected the API key \(HTTP 401\)/)
    assert.match(raw.stderr.join(''), /Connect → Agents/)
  } finally {
    raw.done()
    stand.server.close()
  }
})
