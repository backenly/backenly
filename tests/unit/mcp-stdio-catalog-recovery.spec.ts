/**
 * The stdio MCP server recovers a tool catalog that failed to load at boot.
 *
 * It used to fetch the manifest exactly once. A brief outage while the host
 * started the server left that session on the three fallback tools for its
 * whole life, while the log promised the full list would load. Now the catalog
 * is retried in the background and the host is sent `tools/list_changed`.
 *
 * The real server runs as a child process (through tsx) speaking stdio
 * JSON-RPC, against a local stand-in for backenly.com whose manifest fails for
 * the whole boot attempt and then succeeds.
 */

import http from 'http'
import { AddressInfo } from 'net'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const ROOT = path.join(__dirname, '..', '..')
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const ENTRY = path.join(ROOT, 'packages', 'mcp-server', 'src', 'cli.ts')
const KEY = 'mcp_live_' + 'a'.repeat(32)

const FULL = ['backend_chat', 'read_backend_state', 'fetch_docs', 'apply_migration', 'get_table_schema'].map((name) => ({
  name,
  tier: 'read',
  description: `${name} tool`,
  inputSchema: { type: 'object', properties: {} },
  annotations: { title: name, readOnlyHint: name !== 'apply_migration', destructiveHint: false, idempotentHint: true, openWorldHint: false },
}))

let server: http.Server
let base = ''
let manifestCalls = 0
// The boot attempt makes three tries (the client's own retries); fail all of them.
const FAILURES_BEFORE_SUCCESS = 3

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.url === '/api/mcp/health') {
      return send(200, { ok: true, projectId: 'p1', project: { name: 'Demo' }, toolCount: FULL.length })
    }
    if (req.url === '/api/mcp/manifest') {
      manifestCalls++
      if (manifestCalls <= FAILURES_BEFORE_SUCCESS) return send(503, { ok: false, error: 'warming up' })
      return send(200, { ok: true, tools: FULL })
    }
    send(404, { ok: false, error: 'not found' })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((r) => server.close(() => r())))

/** Minimal line-delimited JSON-RPC client over the child's stdio. */
function rpcClient(child: ChildProcessWithoutNullStreams) {
  const messages: any[] = []
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let nl: number
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line) messages.push(JSON.parse(line))
    }
  })
  const send = (msg: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
  const waitFor = async (pred: (m: any) => boolean, ms: number) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const hit = messages.find(pred)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`timed out; saw ${JSON.stringify(messages.map((m) => m.method ?? m.id))}`)
  }
  return { send, waitFor }
}

it('serves the fallback, then loads the full catalog and tells the host the list changed', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-mcp-home-'))
  const child = spawn(process.execPath, [TSX, ENTRY, '--key', KEY, '--endpoint', base], {
    env: { ...process.env, HOME: home, USERPROFILE: home, BACKENLY_API_KEY: '', BACKENLY_MCP_CATALOG_RETRY_MS: '300' },
  })
  try {
    const rpc = rpcClient(child)

    rpc.send({
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    })
    const init = await rpc.waitFor((m) => m.id === 1, 20_000)
    expect(init.result.capabilities.tools.listChanged).toBe(true)
    rpc.send({ method: 'notifications/initialized' })

    rpc.send({ id: 2, method: 'tools/list' })
    const degraded = await rpc.waitFor((m) => m.id === 2, 5_000)
    expect(degraded.result.tools.map((t: any) => t.name)).toEqual(['backend_chat', 'read_backend_state', 'fetch_docs'])

    await rpc.waitFor((m) => m.method === 'notifications/tools/list_changed', 15_000)

    rpc.send({ id: 3, method: 'tools/list' })
    const full = await rpc.waitFor((m) => m.id === 3, 5_000)
    expect(full.result.tools.map((t: any) => t.name)).toEqual(FULL.map((t) => t.name))
    // Annotations from the manifest reach the host.
    const migration = full.result.tools.find((t: any) => t.name === 'apply_migration')
    expect(migration.annotations.readOnlyHint).toBe(false)
    expect(migration.title).toBe('apply_migration')
  } finally {
    child.kill()
    fs.rmSync(home, { recursive: true, force: true })
  }
}, 45_000)
