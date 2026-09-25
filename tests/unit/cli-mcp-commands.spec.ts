/**
 * `backenly tools | call | chat` — the same-session door onto the MCP tools.
 *
 * A host reads its MCP config when a conversation starts, so an agent that has
 * just installed the Backenly MCP server has no Backenly tools until the next
 * conversation. These commands give it the same tools now, through the same
 * /api/mcp/* handlers and the same key. What they must get right is the request
 * they send, the arguments they build from shell-safe input, and the exit code
 * an agent branches on.
 *
 * The real CLI runs as a child process against a local recorder server.
 */

import http from 'http'
import { AddressInfo } from 'net'
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const CLI = path.join(__dirname, '..', '..', 'packages', 'cli', 'bin', 'backenly.mjs')
const KEY = 'mcp_live_0123456789abcdef'

interface Seen {
  method: string
  url: string
  apiKey: string | undefined
  body: any
}

let server: http.Server
let base = ''
const seen: Seen[] = []
let reply: { status: number; body: unknown } = { status: 200, body: { ok: true, summary: 'done', data: null } }

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      seen.push({
        method: req.method!,
        url: req.url!,
        apiKey: req.headers['x-api-key'] as string | undefined,
        body: raw ? JSON.parse(raw) : null,
      })
      res.writeHead(reply.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply.body))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((r) => server.close(() => r())))

beforeEach(() => {
  seen.length = 0
  reply = { status: 200, body: { ok: true, summary: 'done', data: null, timing: { ms: 3 } } }
})

function cli(args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args, '--key', KEY, '--url', base],
      { cwd: os.tmpdir(), env: { ...process.env, BACKENLY_API_KEY: '' } },
      (err, stdout, stderr) => resolve({ code: err ? (err as any).code ?? 1 : 0, stdout, stderr }),
    )
    if (stdin !== undefined) {
      child.stdin!.end(stdin)
    }
  })
}

describe('backenly call', () => {
  it('posts the tool and key=value arguments to the MCP tool handler with the key', async () => {
    const r = await cli(['call', 'read_backend_state', 'section=schema'])

    expect(r.code).toBe(0)
    expect(seen).toEqual([
      { method: 'POST', url: '/api/mcp/tool', apiKey: KEY, body: { tool: 'read_backend_state', args: { section: 'schema' } } },
    ])
  })

  it('parses JSON-looking values and keeps prose as text', async () => {
    await cli(['call', 'db_insert', 'table=posts', 'row={"title":"hi","likes":2}', 'sql=CREATE TABLE a (b text)'])

    expect(seen[0].body.args).toEqual({ table: 'posts', row: { title: 'hi', likes: 2 }, sql: 'CREATE TABLE a (b text)' })
  })

  it('splits a key=value pair on the first = only', async () => {
    await cli(['call', 'set_rls', 'using=a = b'])
    expect(seen[0].body.args).toEqual({ using: 'a = b' })
  })

  it('reads arguments from a file, for shells that mangle inline quotes', async () => {
    const file = path.join(os.tmpdir(), `bk-args-${process.pid}.json`)
    fs.writeFileSync(file, JSON.stringify({ sql: 'CREATE TABLE posts (title text)' }))
    try {
      await cli(['call', 'apply_migration', '--args-file', file])
    } finally {
      fs.unlinkSync(file)
    }
    expect(seen[0].body).toEqual({ tool: 'apply_migration', args: { sql: 'CREATE TABLE posts (title text)' } })
  })

  it('reads arguments from stdin with --args -', async () => {
    await cli(['call', 'get_table_schema', '--args', '-'], '{"tableName":"posts"}')
    expect(seen[0].body).toEqual({ tool: 'get_table_schema', args: { tableName: 'posts' } })
  })

  it('routes backend_chat to the brain handler, not the typed one', async () => {
    await cli(['call', 'backend_chat', 'message=add a likes column'])
    expect(seen[0].url).toBe('/api/mcp/chat')
    expect(seen[0].body).toEqual({ message: 'add a likes column' })
  })

  it('exits 1 and prints the platform error when the tool fails', async () => {
    reply = { status: 400, body: { ok: false, error: 'Unknown section "x".', code: 'UNKNOWN_SECTION', timing: { ms: 1 } } }
    const r = await cli(['call', 'read_backend_state', 'section=x'])

    expect(r.code).toBe(1)
    const printed = JSON.parse(r.stdout)
    expect(printed).toEqual({ ok: false, error: 'Unknown section "x".', code: 'UNKNOWN_SECTION' })
  })

  it('exits 1 on an auth failure too, so an agent never mistakes it for success', async () => {
    reply = { status: 401, body: { ok: false, error: 'Invalid API key.', code: 'INVALID_KEY' } }
    const r = await cli(['call', 'read_backend_state'])
    expect(r.code).toBe(1)
  })

  it('refuses a key=value object the shell mangled instead of sending it as text', async () => {
    // What PowerShell 5.1 passes for row={"title":"hi"}.
    const r = await cli(['call', 'db_insert', 'table=posts', 'row={title:hi}'])
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/--args-file/)
    expect(seen).toEqual([])
  })

  it('keeps a date-like value as text rather than failing', async () => {
    await cli(['call', 'db_query', 'table=events', 'day=2026-09-25'])
    expect(seen[0].body.args).toEqual({ table: 'events', day: '2026-09-25' })
  })

  it('refuses malformed JSON before sending anything', async () => {
    const r = await cli(['call', 'db_insert', '{"table":'])
    expect(r.code).toBe(1)
    expect(seen).toEqual([])
  })
})

describe('backenly chat', () => {
  it('sends the whole sentence as one backend_chat message', async () => {
    await cli(['chat', 'add', 'a', 'posts', 'table'])
    expect(seen).toEqual([{ method: 'POST', url: '/api/mcp/chat', apiKey: KEY, body: { message: 'add a posts table' } }])
  })
})

describe('backenly tools', () => {
  it('reads the manifest with the key and lists what it advertises', async () => {
    reply = {
      status: 200,
      body: {
        ok: true,
        server: { readOnly: false },
        tools: [
          { name: 'read_backend_state', description: 'Read state. More.', annotations: { readOnlyHint: true } },
          { name: 'apply_migration', description: 'Apply DDL.', annotations: { readOnlyHint: false } },
        ],
      },
    }
    const r = await cli(['tools'])

    expect(r.code).toBe(0)
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/api/mcp/manifest', apiKey: KEY })
    expect(r.stdout).toMatch(/read_backend_state\s+read\s+Read state\./)
    expect(r.stdout).toMatch(/apply_migration\s+write\s+Apply DDL\./)
  })
})
