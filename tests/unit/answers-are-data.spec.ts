/**
 * A FUNCTION'S ANSWER AND THE REST APIS' ARE DATA, NEVER A PAGE OF THE ORIGIN
 * ============================================================================
 *
 * Three surfaces answer from Backenly's own origin with content a project
 * chose: /api/v1/{projectId}/fn/{name}, where a function picks its answer's
 * content type, and the REST APIs, /api/v1/{projectId}/db/… and
 * /api/v2/{projectId}/…, where PostgREST answers in the media type the request
 * asked for. So (lib/security/data-answers.ts):
 *
 *   - a type a browser shows as a page or runs as script (HTML, the XML types,
 *     XHTML and SVG among them, the JavaScript types) is sent as text/plain,
 *     with its charset; JSON, text and every other type, PostgREST's own
 *     among them, as written (dataAnswerType);
 *   - every answer on those paths carries `X-Content-Type-Options: nosniff`
 *     and `Content-Security-Policy: sandbox; default-src 'none'`, from the
 *     runtime (server/app.ts), the web server's forwarder
 *     (lib/runtime/forward-to-runtime.ts) and next.config.js.
 *
 * The config's rules are matched here with Next's own loader and matcher
 * (tests/helpers/next-config-headers.ts). The full paths through the runtime
 * and through Next's middleware, route and response code are
 * tests/integration/function-answers-are-data.spec.ts and
 * tests/integration/rest-answers-are-data.spec.ts.
 */

jest.mock('@sentry/nextjs', () => ({ withSentryConfig: (config: unknown) => config }))

import '@/tests/helpers/real-web-standard'

import http from 'http'
import type { AddressInfo } from 'net'
import { answerHeaders } from '@/lib/services/ai-functions/reply'
import {
  DATA_ANSWER_HEADERS,
  dataAnswerType,
  isDataAnswerPath,
  isFunctionAnswerPath,
  isTableAnswerPath,
} from '@/lib/security/data-answers'
import { configHeadersFor, nextConfigHeaderRules, type HeaderRule } from '@/tests/helpers/next-config-headers'

const P = '0b6f3c1e-1d2a-4c55-9a1e-7f2d3b4c5d6e'
const SANDBOX = "sandbox; default-src 'none'"

describe('the content type an answer on a data path is sent with', () => {
  it.each([
    ['text/html', 'text/plain'],
    ['text/html; charset=utf-8', 'text/plain; charset=utf-8'],
    ['TEXT/HTML ; Charset="ISO-8859-1"', 'text/plain; charset=ISO-8859-1'],
    ['application/xhtml+xml', 'text/plain'],
    ['image/svg+xml; charset=utf-8', 'text/plain; charset=utf-8'],
    ['text/xml', 'text/plain'],
    // Chrome and Safari show text/xsl as an XML document, XHTML script and all.
    ['text/xsl', 'text/plain'],
    ['application/xml', 'text/plain'],
    ['application/rss+xml', 'text/plain'],
    ['application/javascript', 'text/plain'],
    ['text/javascript; charset=UTF-8', 'text/plain; charset=UTF-8'],
    ['application/x-javascript', 'text/plain'],
    ['text/ecmascript', 'text/plain'],
    ['text/jscript', 'text/plain'],
    ['multipart/x-mixed-replace; boundary=next', 'text/plain'],
    // Browsers read a list of types as its last one.
    ['text/plain, text/html', 'text/plain'],
    ['', 'text/plain'],
  ])('sends %j as %j', (written, sent) => {
    expect(dataAnswerType(written)).toBe(sent)
  })

  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'application/problem+json',
    'text/plain',
    'text/plain;charset=UTF-8',
    'text/csv; charset=utf-8',
    'text/event-stream',
    'image/png',
    'application/pdf',
    'application/octet-stream',
  ])('sends %j as written', (type) => {
    expect(dataAnswerType(type)).toBe(type)
  })

  // What PostgREST itself answers with, on /api/v2.
  it.each([
    'application/json; charset=utf-8',
    'application/geo+json; charset=utf-8',
    'application/vnd.pgrst.object+json; charset=utf-8',
    'application/vnd.pgrst.object+json;nulls=stripped',
    'application/vnd.pgrst.array+json;nulls=stripped',
    'application/vnd.pgrst.plan+json; for="application/json"; charset=utf-8',
    'application/vnd.pgrst.plan+text; for="application/json"; charset=utf-8',
    'text/csv; charset=utf-8',
    'application/octet-stream',
    'text/plain; charset=utf-8',
  ])('sends PostgREST’s %j as written', (type) => {
    expect(dataAnswerType(type)).toBe(type)
  })

  it('applies to a function answer’s headers, and keeps its caching', () => {
    expect(answerHeaders({ 'Content-Type': 'text/html', 'Cache-Control': 'no-store', 'Set-Cookie': 'a=b' })).toEqual({
      'content-type': 'text/plain',
      'cache-control': 'no-store',
    })
    expect(answerHeaders({ 'content-type': 'application/json' })).toEqual({ 'content-type': 'application/json' })
  })
})

const FUNCTION_PATHS = [
  `/api/v1/${P}/fn/report`,
  `/api/v1/${P}/fn/report/extra`,
  `/api/v1/${P}/FN/report`,
  `/api/v1/${P}/db/fn/report`,
  `/api/v1/${P}/DB/Fn/report`,
  '/api/v1/fn/report',
  '/api/v1/db/fn/report',
]

const TABLE_PATHS = [
  `/api/v1/${P}/db`,
  `/api/v1/${P}/db/orders`,
  `/api/v1/${P}/db/orders/42`,
  `/api/v1/${P}/DB/orders`,
  `/api/v1/${P}/db/orders/vector-search`,
  '/api/v1/db/orders',
]

const V2_PATHS = [
  '/api/v2',
  `/api/v2/${P}`,
  `/api/v2/${P}/orders`,
  `/api/v2/${P}/orders?select=*,author(*)`.split('?')[0],
  `/api/v2/${P}/fn/report`,
  `/API/V2/${P}/orders`,
]

const OTHER_PATHS = [
  `/api/v1/${P}`,
  `/api/v1/${P}/orders`,
  `/api/v1/${P}/orders/fn`,
  `/api/v1/${P}/functions`,
  `/api/v1/${P}/functions/invoke`,
  `/api/v1/${P}/fn`,
  `/api/v1/${P}/a/b/fn/report`,
  `/api/v1/${P}/auth/signin`,
  `/api/v1/${P}/storage/files`,
  `/api/v1/${P}/dbx/orders`,
  // Percent-encoded, these are not those paths: the runtime calls no function
  // and serves no table on them (server/routes/dynamic.ts).
  `/api/v1/${P}/%66n/report`,
  `/api/v1/${P}/fn%2Freport`,
  `/api/v1/${P}/%64b/fn/report`,
  `/api/v1/${P}/%64b/orders`,
  '/api/v2x/orders',
  '/api/storage/files/0b6f3c1e-1d2a-4c55-9a1e-7f2d3b4c5d6e/download',
  '/app/projects/p1/functions',
  '/',
]

describe('which paths answer with data', () => {
  it.each(FUNCTION_PATHS)('%s is a function’s path', (path) => {
    expect(isFunctionAnswerPath(path)).toBe(true)
    expect(isDataAnswerPath(path)).toBe(true)
  })

  it.each(TABLE_PATHS)('%s is the v1 REST API’s', (path) => {
    expect(isTableAnswerPath(path)).toBe(true)
    expect(isDataAnswerPath(path)).toBe(true)
  })

  it.each(V2_PATHS)('%s is the v2 REST API’s', (path) => {
    expect(isDataAnswerPath(path)).toBe(true)
  })

  it.each(OTHER_PATHS)('%s is none of them', (path) => {
    expect(isDataAnswerPath(path)).toBe(false)
  })

  it('takes repeated slashes as one, as the runtime does', () => {
    expect(isFunctionAnswerPath(`/api/v1/${P}//fn//report`)).toBe(true)
    expect(isTableAnswerPath(`/api/v1/${P}//db//orders`)).toBe(true)
  })
})

describe('what next.config.js sends', () => {
  let rules: HeaderRule[]
  beforeAll(async () => {
    rules = await nextConfigHeaderRules()
  })

  it.each([...FUNCTION_PATHS, ...TABLE_PATHS, ...V2_PATHS])('%s: the sandbox policy and nosniff, in place of the site’s policy', (path) => {
    const headers = configHeadersFor(rules, path)
    expect(headers['content-security-policy']).toBe(SANDBOX)
    expect(headers['x-content-type-options']).toBe('nosniff')
    // The rest of the site's headers stay.
    expect(headers['x-frame-options']).toBe('SAMEORIGIN')
  })

  it('the same two values the runtime and the forwarder send', () => {
    const headers = configHeadersFor(rules, FUNCTION_PATHS[0])
    for (const [name, value] of Object.entries(DATA_ANSWER_HEADERS)) expect(headers[name.toLowerCase()]).toBe(value)
  })

  it.each(OTHER_PATHS.filter((p) => !p.startsWith('/api/storage/')))('%s: the site’s policy', (path) => {
    const policy = configHeadersFor(rules, path)['content-security-policy']
    expect(policy).toMatch(/^default-src 'self'; script-src 'self'/)
  })

  it('on exactly the paths that answer with data', () => {
    for (const path of [...FUNCTION_PATHS, ...TABLE_PATHS, ...V2_PATHS, ...OTHER_PATHS]) {
      const sandboxed = configHeadersFor(rules, path)['content-security-policy'] === SANDBOX
      expect({ path, sandboxed }).toEqual({ path, sandboxed: isDataAnswerPath(path) })
    }
  })
})

describe('why the policy for these paths is set in next.config.js, not only by the route', () => {
  it('Next sends the config’s value of a header the route also sets, and the route’s value of one the config leaves alone', async () => {
    const { sendResponse } = require('next/dist/server/send-response')
    const { NodeNextResponse } = require('next/dist/server/base-http/node')
    const server = http.createServer(async (req, res) => {
      // server/lib/router-server.js sets the config's headers before the route runs.
      res.setHeader('Content-Security-Policy', 'from-config')
      const fromRoute = new Response('x', { headers: { 'content-security-policy': 'from-route', 'content-type': 'text/plain' } })
      await sendResponse(req, new NodeNextResponse(res), fromRoute)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)
      expect(res.headers.get('content-security-policy')).toBe('from-config')
      expect(res.headers.get('content-type')).toBe('text/plain')
      await res.text()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
