/**
 * The two MCP transports, driven by the official client, for suites that
 * compare them.
 *
 *   remote: the official client -> app/api/mcp/route.ts, in process
 *   stdio:  the official client -> the BUILT package (dist/cli.js, what npm
 *           ships), spawned -> an HTTP server serving this repository's routes
 *
 * The suite passes in the route handlers it wants served, so each one decides
 * which are real and which are fixtures.
 */

import './real-web-standard'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

export type Era = 'legacy' | 'modern'
type Handler = (req: NextRequest) => Promise<Response>

export const STDIO_ENTRY = path.join(__dirname, '..', '..', 'packages', 'mcp-server', 'dist', 'cli.js')

/** Fails, rather than skips, when the package has not been built. */
export function requireBuiltPackage(): void {
  if (!fs.existsSync(STDIO_ENTRY)) {
    throw new Error(
      `The stdio package is not built (${STDIO_ENTRY} is missing). ` +
        'Run: npm ci --prefix packages/mcp-server && npm run build --prefix packages/mcp-server',
    )
  }
}

/**
 * backenly.com as the stdio package reaches it. `routes` is keyed
 * "METHOD /path"; anything else is answered 410, so a package that calls a
 * route it should not shows up as a failure.
 */
export function serveBackenly(routes: Record<string, Handler>): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const handler = routes[`${req.method} ${req.url}`]
    if (!handler) {
      res.writeHead(410, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, error: `not a route the package should call: ${req.method} ${req.url}` }))
    }
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
    const response = await handler(new NextRequest(`http://backenly.test${req.url}`, {
      method: req.method,
      headers,
      ...(chunks.length ? { body: Buffer.concat(chunks).toString('utf8') } : {}),
    }))
    res.writeHead(response.status, { 'content-type': 'application/json' })
    res.end(await response.text())
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${(server.address() as any).port}` })),
  )
}

function negotiation(era: Era) {
  return era === 'modern' ? { versionNegotiation: { mode: 'auto' as const } } : {}
}

/** A client of the remote endpoint, reaching the route's own handlers in process. */
export async function remoteClient(era: Era, key: string, route: { POST: Handler; GET: () => Response }): Promise<Client> {
  const client = new Client({ name: 'transport-test', version: '0' }, negotiation(era))
  await client.connect(new StreamableHTTPClientTransport(new URL('https://backenly.test/api/mcp'), {
    requestInit: { headers: { 'x-api-key': key } },
    fetch: (async (url: string | URL, init?: RequestInit) =>
      (init?.method ?? 'GET').toUpperCase() === 'POST'
        ? route.POST(new NextRequest(url.toString(), init as any))
        : route.GET()) as any,
  }))
  return client
}

/** A client of the built stdio package, spawned against `base`. */
export async function stdioClient(era: Era, key: string, base: string, home: string): Promise<Client> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
  const client = new Client({ name: 'transport-test', version: '0' }, negotiation(era))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [STDIO_ENTRY, '--key', key, '--endpoint', base],
    env: { ...env, HOME: home, USERPROFILE: home, BACKENLY_API_KEY: '' },
    stderr: 'pipe',
  })
  // Drained, so the child never blocks on a full pipe, and kept, so a child
  // that dies mid-suite leaves its reason in the output. Written to stderr
  // directly: jest.setup.js drops console.error lines that contain "Error:".
  const stderr: string[] = []
  transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)))
  let closing = false
  client.onclose = () => {
    if (!closing) process.stderr.write(`\nThe stdio server exited before the suite closed it. Its stderr:\n${stderr.join('')}\n`)
  }
  await client.connect(transport)
  const close = client.close.bind(client)
  client.close = async () => {
    closing = true
    await close()
  }
  return client
}

/**
 * A result minus the server's own name and version, which the 2026-07-28 era
 * stamps on every result's `_meta`. That is the one field the transports are
 * meant to differ in.
 */
export function comparable<T>(result: T): T {
  const meta = (result as any)?._meta
  if (!meta || !('io.modelcontextprotocol/serverInfo' in meta)) return result
  const { 'io.modelcontextprotocol/serverInfo': _info, ...rest } = meta
  return { ...(result as any), _meta: rest } as T
}
