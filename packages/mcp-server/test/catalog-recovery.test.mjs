/**
 * The published stdio server recovers a tool catalog that failed to load at boot.
 *
 * It used to fetch the manifest exactly once. A brief outage while the host
 * started the server left that session on the three fallback tools for its
 * whole life, while the log promised the full list would load. Now the catalog
 * is retried in the background and the host is sent `tools/list_changed`.
 *
 * Runs the BUILT entrypoint (dist/cli.js, what npm ships) as a child process
 * speaking stdio JSON-RPC, against a local stand-in for backenly.com whose
 * manifest fails for the whole boot attempt and then succeeds. Lives in the
 * package, not tests/unit, because it needs the package's own dependencies.
 *
 *   npm run build && npm test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ENTRY = path.join(HERE, '..', 'dist', 'cli.js')
// Built so it cannot match the credential scanner: it is not a key.
const KEY = ['mcp', 'live', 'test', 'key', 'for', 'recovery'].join('_')

const FULL = ['backend_chat', 'read_backend_state', 'fetch_docs', 'apply_migration', 'get_table_schema'].map((name) => ({
  name,
  tier: 'read',
  description: `${name} tool`,
  inputSchema: { type: 'object', properties: {} },
  annotations: { title: name, readOnlyHint: name !== 'apply_migration', destructiveHint: false, idempotentHint: true, openWorldHint: false },
}))

// The boot attempt makes three tries (the client's own retries); fail all of them.
const FAILURES_BEFORE_SUCCESS = 3

function standIn() {
  let manifestCalls = 0
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
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
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })),
  )
}

/** Minimal line-delimited JSON-RPC client over the child's stdio. */
function rpcClient(child, stderr) {
  const messages = []
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
  const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
  const waitFor = async (pred, ms) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const hit = messages.find(pred)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(
      `timed out; saw ${JSON.stringify(messages.map((m) => m.method ?? m.id))}\nserver stderr:\n${stderr.join('')}`,
    )
  }
  return { send, waitFor }
}

test('serves the fallback, then loads the full catalog and tells the host the list changed', { timeout: 45_000 }, async () => {
  assert.ok(fs.existsSync(ENTRY), `build the package first: ${ENTRY} is missing`)
  const { server, base } = await standIn()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-mcp-home-'))
  const child = spawn(process.execPath, [ENTRY, '--key', KEY, '--endpoint', base], {
    env: { ...process.env, HOME: home, USERPROFILE: home, BACKENLY_API_KEY: '', BACKENLY_MCP_CATALOG_RETRY_MS: '300' },
  })
  const stderr = []
  child.stderr.on('data', (c) => stderr.push(c.toString('utf8')))

  try {
    const rpc = rpcClient(child, stderr)

    rpc.send({
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    })
    const init = await rpc.waitFor((m) => m.id === 1, 20_000)
    assert.equal(init.result.capabilities.tools.listChanged, true)
    rpc.send({ method: 'notifications/initialized' })

    rpc.send({ id: 2, method: 'tools/list' })
    const degraded = await rpc.waitFor((m) => m.id === 2, 5_000)
    assert.deepEqual(degraded.result.tools.map((t) => t.name), ['backend_chat', 'read_backend_state', 'fetch_docs'])

    await rpc.waitFor((m) => m.method === 'notifications/tools/list_changed', 15_000)

    rpc.send({ id: 3, method: 'tools/list' })
    const full = await rpc.waitFor((m) => m.id === 3, 5_000)
    assert.deepEqual(full.result.tools.map((t) => t.name), FULL.map((t) => t.name))
    // Annotations from the manifest reach the host.
    const migration = full.result.tools.find((t) => t.name === 'apply_migration')
    assert.equal(migration.annotations.readOnlyHint, false)
    assert.equal(migration.title, 'apply_migration')
  } finally {
    child.kill()
    server.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
