#!/usr/bin/env tsx
/**
 * BACKENLY LOCAL DEVELOPMENT PROXY
 * ==================================
 * Starts a local HTTP proxy so frontend developers can test against a local
 * Backenly instance without hitting production.
 *
 * Features:
 *   - Proxies /api/v1/{projectId}/* to a configurable target URL
 *   - Injects the API key automatically so the frontend code doesn't need it
 *   - Logs every request/response for debugging
 *   - Supports CORS for any localhost origin out of the box
 *   - Serves a simple health endpoint at GET /healthz
 *   - Environment-variable driven: no code changes needed
 *
 * Usage:
 *   npx tsx scripts/local-proxy.ts
 *
 * Environment variables:
 *   PROXY_TARGET   — upstream Backenly instance (default: http://localhost:3000)
 *   PROXY_PORT     — local port to listen on (default: 4000)
 *   PROXY_API_KEY  — API key to inject into all requests
 *   PROXY_PROJECT  — project ID to proxy (all requests scoped to this project)
 *
 * .env.local example:
 *   PROXY_TARGET=https://backenly.com
 *   PROXY_PORT=4000
 *   PROXY_API_KEY=proj_live_your_key_here
 *   PROXY_PROJECT=your-project-id
 *
 * Then in your frontend, point to http://localhost:4000 instead of the live URL.
 */

import http from 'http'
import https from 'https'
import { URL } from 'url'

// ── Configuration ─────────────────────────────────────────────────────────────

const TARGET    = process.env.PROXY_TARGET   ?? 'http://localhost:3000'
const PORT      = parseInt(process.env.PROXY_PORT ?? '4000', 10)
const API_KEY   = process.env.PROXY_API_KEY  ?? ''
const PROJECT   = process.env.PROXY_PROJECT  ?? ''

if (!API_KEY) {
  console.warn('[Proxy] ⚠️  PROXY_API_KEY not set — requests will be forwarded without x-api-key')
}

const targetUrl = new URL(TARGET)
const targetIsHttps = targetUrl.protocol === 'https:'
const httpModule = targetIsHttps ? https : http

// ── CORS headers ──────────────────────────────────────────────────────────────

function setCorsHeaders(res: http.ServerResponse, origin?: string | null) {
  const allowedOrigin = (origin && (origin.includes('localhost') || origin.includes('127.0.0.1')))
    ? origin
    : 'http://localhost:3000'
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, X-User-Token, X-User-Id')
  res.setHeader('Access-Control-Max-Age', '86400')
}

// ── Request logger ────────────────────────────────────────────────────────────

function log(method: string, path: string, status: number, ms: number) {
  const color = status >= 500 ? '\x1b[31m' : status >= 400 ? '\x1b[33m' : '\x1b[32m'
  const reset = '\x1b[0m'
  console.log(`${color}[Proxy]${reset} ${method.padEnd(7)} ${path.padEnd(50)} ${color}${status}${reset} ${ms}ms`)
}

// ── Proxy request ─────────────────────────────────────────────────────────────

function proxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requestPath: string
) {
  const start = Date.now()
  const origin = req.headers['origin'] as string | undefined

  // Build upstream request options
  const upstreamHeaders: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.toLowerCase() === 'host') continue // Replace with target host
    if (v !== undefined) upstreamHeaders[k] = v as string | string[]
  }

  // Inject API key if configured
  if (API_KEY) {
    upstreamHeaders['x-api-key'] = API_KEY
  }

  upstreamHeaders['host'] = targetUrl.host

  const options: http.RequestOptions = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetIsHttps ? 443 : 80),
    path: requestPath + (req.url?.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''),
    method: req.method,
    headers: upstreamHeaders,
  }

  const proxyReq = httpModule.request(options, (proxyRes) => {
    // Copy response headers
    const responseHeaders: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (v !== undefined) responseHeaders[k] = v as string | string[]
    }

    // Override CORS headers — the proxy handles them
    setCorsHeaders(res, origin)

    res.writeHead(proxyRes.statusCode ?? 200, responseHeaders)
    proxyRes.pipe(res)

    proxyRes.on('end', () => {
      log(req.method ?? 'GET', requestPath, proxyRes.statusCode ?? 0, Date.now() - start)
    })
  })

  proxyReq.on('error', (err) => {
    console.error(`[Proxy] Upstream error: ${err.message}`)
    if (!res.headersSent) {
      setCorsHeaders(res, origin)
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Bad Gateway', detail: err.message }))
    }
    log(req.method ?? 'GET', requestPath, 502, Date.now() - start)
  })

  req.pipe(proxyReq)
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const origin = req.headers['origin'] as string | undefined
  const rawPath = req.url ?? '/'

  // CORS preflight
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res, origin)
    res.writeHead(204)
    res.end()
    return
  }

  // Health check
  if (rawPath === '/healthz' || rawPath === '/health') {
    setCorsHeaders(res, origin)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'ok',
      proxy: { target: TARGET, projectId: PROJECT || '(any)', apiKeySet: !!API_KEY },
    }))
    return
  }

  // Route: if PROJECT is set, automatically prefix /api/v1/{PROJECT}
  let upstreamPath = rawPath
  if (PROJECT && !rawPath.startsWith(`/api/v1/${PROJECT}`)) {
    // Allow bare /tableName paths to be shortcutted to /api/v1/{PROJECT}/database/query?table=tableName
    if (/^\/[a-z_][a-z0-9_]*(\?.*)?$/i.test(rawPath)) {
      const [tablePath, qs] = rawPath.split('?')
      const table = tablePath.replace('/', '')
      const query = qs ? `&${qs}` : ''
      upstreamPath = `/api/v1/${PROJECT}/database/query?table=${table}${query}`
    } else {
      // Prepend project prefix
      upstreamPath = `/api/v1/${PROJECT}${rawPath}`
    }
  }

  proxyRequest(req, res, upstreamPath)
})

server.listen(PORT, () => {
  console.log('\n\x1b[36m╔══════════════════════════════════════════════════════╗')
  console.log('║         BACKENLY LOCAL DEVELOPMENT PROXY             ║')
  console.log('╚══════════════════════════════════════════════════════╝\x1b[0m\n')
  console.log(`  Listening on:  \x1b[1mhttp://localhost:${PORT}\x1b[0m`)
  console.log(`  Proxying to:   \x1b[1m${TARGET}\x1b[0m`)
  if (PROJECT) console.log(`  Project:       \x1b[1m${PROJECT}\x1b[0m`)
  if (API_KEY) console.log(`  API Key:       \x1b[1m${API_KEY.substring(0, 16)}...\x1b[0m (auto-injected)`)
  console.log()
  console.log('  Shortcuts (when PROXY_PROJECT is set):')
  console.log(`    GET http://localhost:${PORT}/your_table   → /api/v1/{project}/database/query?table=your_table`)
  console.log(`    POST http://localhost:${PORT}/api/v1/{project}/database/insert`)
  console.log()
  console.log('  Endpoints:')
  console.log(`    GET  http://localhost:${PORT}/healthz   → proxy health check`)
  if (PROJECT) {
    console.log(`    GET  http://localhost:${PORT}/api/v1/${PROJECT}/database/query?table=<name>`)
    console.log(`    POST http://localhost:${PORT}/api/v1/${PROJECT}/database/insert`)
    console.log(`    GET  http://localhost:${PORT}/api/v1/${PROJECT}/realtime`)
  }
  console.log('\n  Press Ctrl+C to stop\n')
})

process.on('SIGINT',  () => { server.close(); process.exit(0) })
process.on('SIGTERM', () => { server.close(); process.exit(0) })
