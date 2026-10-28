/**
 * NO CUSTOMER DATA IN ERROR REPORTS
 * =================================
 * Error reports go to Sentry, a third party, and customer data stays out of
 * them:
 *
 *   - the scrubber every report, transaction and span passes through removes
 *     rows, request bodies, credentials, client addresses, query strings, SQL
 *     literals, console output and third parties' URL paths;
 *   - every Sentry configuration sends reports through it;
 *   - the trigger failure reports identifiers only;
 *   - no capture call anywhere attaches context under a name that carries
 *     customer data.
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  REMOVED,
  scrubErrorReport,
  scrubReportSpan,
  scrubUrl,
  withoutLiterals,
  withoutQuery,
} from '@/lib/observability/error-report-scrub'
import { hostOf, triggerReportContext } from '@/lib/services/trigger-service'

const ROOT = process.cwd()
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')

const APP_URL = process.env.NEXT_PUBLIC_APP_URL
beforeAll(() => {
  process.env.NEXT_PUBLIC_APP_URL = 'https://backenly.com'
})
afterAll(() => {
  if (APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = APP_URL
})

describe('the scrubber', () => {
  it('removes rows, payloads and credentials from the context, and keeps identifiers', () => {
    const report = scrubErrorReport({
      extra: {
        projectId: 'p1',
        table: 'orders',
        eventType: 'insert',
        attempts: 3,
        event: { type: 'insert', table: 'orders', data: { email: 'customer@example.com' } },
        data: { card: '4242' },
        old: { email: 'old@example.com' },
        rows: [{ id: 1 }],
        __serialized__: { email: 'customer@example.com' },
        trigger: { id: 't1', webhookSecret: 'whsec_1', payload: { email: 'customer@example.com' } },
        detail: 'POST https://hooks.example.com/services/T0/B0/s3cret failed',
      },
    })
    expect(report.extra).toEqual({
      projectId: 'p1',
      table: 'orders',
      eventType: 'insert',
      attempts: 3,
      event: REMOVED,
      data: REMOVED,
      old: REMOVED,
      rows: REMOVED,
      __serialized__: REMOVED,
      trigger: { id: 't1', webhookSecret: REMOVED, payload: REMOVED },
      detail: 'POST https://hooks.example.com failed',
    })
    expect(JSON.stringify(report)).not.toMatch(/customer@example\.com|s3cret|whsec_1|4242/)
  })

  it("keeps the trace context's ids and scrubs its attributes like any span's", () => {
    const report = scrubErrorReport({
      contexts: {
        trace: {
          trace_id: 'a'.repeat(32),
          span_id: 'b'.repeat(16),
          op: 'http.server',
          data: {
            'sentry.op': 'http.server',
            'url.full': 'https://backenly.com/api/v1/p1/realtime?ticket=t0k',
            'url.query': '?ticket=t0k',
          },
        },
        trigger: { event: { data: 1 }, id: 't1' },
      },
    })
    expect(report.contexts).toEqual({
      trace: {
        trace_id: 'a'.repeat(32),
        span_id: 'b'.repeat(16),
        op: 'http.server',
        data: { 'sentry.op': 'http.server', 'url.full': 'https://backenly.com/api/v1/p1/realtime', 'url.query': REMOVED },
      },
      trigger: { event: REMOVED, id: 't1' },
    })
  })

  it('removes request bodies, cookies, credentials, client addresses and query strings', () => {
    const report = scrubErrorReport({
      request: {
        url: `https://backenly.com/app/invite/${'f'.repeat(48)}?utm=x`,
        data: '{"email":"customer@example.com"}',
        cookies: { session: 's' },
        env: { REMOTE_ADDR: '203.0.113.9' },
        query_string: 'ticket=t0k',
        headers: {
          Authorization: 'Bearer eyJ',
          'x-api-key': 'proj_live_x',
          'X-User-Token': 'eyJ',
          'x-forwarded-for': '203.0.113.9',
          'user-agent': 'ua',
          referer: 'https://backenly.com/app/projects/p1?code=oauth-code',
        },
      },
    })
    expect(report.request).toEqual({
      url: `https://backenly.com/app/invite/${REMOVED}`,
      query_string: REMOVED,
      headers: {
        Authorization: REMOVED,
        'x-api-key': REMOVED,
        'X-User-Token': REMOVED,
        'x-forwarded-for': REMOVED,
        'user-agent': 'ua',
        referer: 'https://backenly.com/app/projects/p1',
      },
    })
  })

  it("drops console breadcrumbs, and keeps only a third party's origin", () => {
    const report = scrubErrorReport({
      breadcrumbs: [
        { category: 'console', message: 'row {"email":"customer@example.com"}' },
        {
          category: 'http',
          data: { url: 'https://hooks.example.com/services/T0/B0/s3cret', method: 'POST', 'http.query': 'token=abc', status_code: 500 },
        },
        { category: 'fetch', data: { url: '/api/v1/p1/storage/buckets/avatars/jane-passport.pdf', method: 'GET' } },
        { category: 'navigation', data: { from: '/app/projects/p1', to: '/app/auth/callback?code=oauth-code' } },
      ],
    })
    expect(report.breadcrumbs).toEqual([
      { category: 'http', data: { url: 'https://hooks.example.com', method: 'POST', 'http.query': REMOVED, status_code: 500 } },
      { category: 'fetch', data: { url: `/api/v1/p1/storage/buckets/avatars/${REMOVED}`, method: 'GET' } },
      { category: 'navigation', data: { from: '/app/projects/p1', to: '/app/auth/callback' } },
    ])
  })

  it('keeps only the id of the user an error hit', () => {
    expect(scrubErrorReport({ user: { id: 'u1', email: 'dev@example.com', ip_address: '203.0.113.9' } }).user).toEqual({ id: 'u1' })
    expect(scrubErrorReport({ user: { ip_address: '203.0.113.9' } }).user).toBeUndefined()
  })

  it('scrubs URLs in error messages, and drops frame variables', () => {
    const report = scrubErrorReport({
      message: 'fetch https://hooks.example.com/in/s3cret?token=abc failed',
      exception: {
        values: [
          {
            value: 'connect ECONNREFUSED postgres://admin:password@db.internal:5432/app',
            stacktrace: { frames: [{ vars: { row: { email: 'customer@example.com' } } }] },
          },
        ],
      },
    })
    expect(report.message).toBe('fetch https://hooks.example.com failed')
    expect(report.exception!.values![0].value).toBe('connect ECONNREFUSED postgres://db.internal:5432')
    expect(report.exception!.values![0].stacktrace!.frames![0]).toEqual({})
  })
})

describe('a span', () => {
  it("to a third party keeps only the receiver's origin", () => {
    const span = scrubReportSpan({
      op: 'http.client',
      description: 'POST https://hooks.example.com/services/T0/B0/s3cret',
      data: {
        'url.full': 'https://hooks.example.com/services/T0/B0/s3cret?token=abc',
        'url.path': '/services/T0/B0/s3cret',
        'url.query': '?token=abc',
        'server.address': 'hooks.example.com',
        'http.request.method': 'POST',
      },
    })
    expect(span).toEqual({
      op: 'http.client',
      description: 'POST https://hooks.example.com',
      data: {
        'url.full': 'https://hooks.example.com',
        'url.path': REMOVED,
        'url.query': REMOVED,
        'server.address': 'hooks.example.com',
        'http.request.method': 'POST',
      },
    })
  })

  it('to the platform keeps its route, never its query', () => {
    const span = scrubReportSpan({ op: 'http.client', description: 'GET /api/v1/p1/db/orders?filter=email.eq.customer@example.com', data: {} })
    expect(span.description).toBe('GET /api/v1/p1/db/orders')
  })

  it('of a query keeps the statement and none of its values', () => {
    const span = scrubReportSpan({
      op: 'db',
      description: `SELECT * FROM "workspace_p1"."orders" WHERE email = 'customer@example.com' AND total > 41.5 AND id = $1 LIMIT 10`,
      data: { 'db.statement': `UPDATE t SET note = 'it''s mine' WHERE id = 7`, 'db.system': 'postgresql' },
    })
    expect(span.description).toBe(`SELECT * FROM "workspace_p1"."orders" WHERE email = '?' AND total > ? AND id = $1 LIMIT ?`)
    expect(span.data).toEqual({ 'db.statement': `UPDATE t SET note = '?' WHERE id = ?`, 'db.system': 'postgresql' })
  })
})

describe('a URL', () => {
  it("of a third party keeps its origin, of the platform its route words and ids", () => {
    expect(scrubUrl('https://hooks.example.com/in/s3cret?token=abc')).toBe('https://hooks.example.com')
    expect(scrubUrl('https://us-east-1.api.backenly.com/api/v1/p1/db/orders')).toBe('https://us-east-1.api.backenly.com/api/v1/p1/db/orders')
    expect(scrubUrl('https://user:password@backenly.com/app')).toBe('https://backenly.com/app')
    expect(scrubUrl('/api/v1/p1/storage/report%20Q3.pdf')).toBe(`/api/v1/p1/storage/${REMOVED}`)
    expect(scrubUrl('/api/v1/p1/db/orders/3f2c1a9e-8d7b-4c6a-9e5f-1a2b3c4d5e6f')).toBe('/api/v1/p1/db/orders/3f2c1a9e-8d7b-4c6a-9e5f-1a2b3c4d5e6f')
    expect(scrubUrl('/api/v1/[projectId]/fn/[...name]')).toBe('/api/v1/[projectId]/fn/[...name]')
  })

  it('is cut at its query or fragment', () => {
    expect(withoutQuery('https://a.test/x?y=1#z')).toBe('https://a.test/x')
    expect(withoutQuery('https://a.test/x#z')).toBe('https://a.test/x')
    expect(withoutQuery('https://a.test/x')).toBe('https://a.test/x')
  })

  it('in SQL text is not mistaken for a literal, nor is a placeholder', () => {
    expect(withoutLiterals('SELECT 1 FROM t2 WHERE a = $2')).toBe('SELECT ? FROM t2 WHERE a = $2')
  })
})

describe('a trigger failure', () => {
  it('reports which event failed, never its row', () => {
    const context = triggerReportContext('p1', {
      type: 'update',
      table: 'customers',
      data: { email: 'customer@example.com' },
      old: { email: 'before@example.com' },
    })
    expect(context).toEqual({ projectId: 'p1', table: 'customers', eventType: 'update' })
  })

  it('names a failing receiver by its host only', () => {
    expect(hostOf('https://hooks.example.com/in/secret?token=abc')).toBe('hooks.example.com')
    expect(hostOf(null)).toBe('none')
    expect(hostOf('not a url')).toBe('unparseable')
  })
})

describe('every Sentry configuration', () => {
  /** The text of one `before*` hook, up to the next hook. */
  function hook(source: string, name: string): string {
    const start = source.search(new RegExp(`\\b${name}\\b`))
    if (start === -1) return ''
    const next = source.slice(start + name.length).search(/\bbeforeSend/)
    return next === -1 ? source.slice(start) : source.slice(start, start + name.length + next)
  }

  for (const file of ['sentry.server.config.ts', 'sentry.edge.config.ts', 'sentry.client.config.ts']) {
    it(`${file} sends every report, transaction and span through the scrubber`, () => {
      const source = read(file)
      expect(hook(source, 'beforeSend')).toContain('scrubErrorReport')
      expect(hook(source, 'beforeSendTransaction')).toContain('scrubErrorReport')
      expect(hook(source, 'beforeSendSpan')).toContain('scrubReportSpan')
      expect(source).toMatch(/sendDefaultPii:\s*false/)
    })
  }
})

describe('every capture call', () => {
  /** Names under which context carries customer data (the scrubber's list). */
  const FORBIDDEN_KEY = /(?:^|[\s{,])(event|data|old|new|record|records|row|rows|payload|body|values|__serialized__)\s*(?=[,}:]|$)/

  function sources(dir: string): string[] {
    const out: string[] = []
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') out.push(...sources(rel))
      } else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel)
    }
    return out
  }

  /** The text between the braces that follow `key:`, or '' when there are none. */
  function objectAfter(text: string, key: string): string {
    const at = new RegExp(`\\b${key}\\s*:\\s*\\{`).exec(text)
    if (!at) return ''
    const start = at.index + at[0].length
    let depth = 1
    let i = start
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') depth--
    }
    return text.slice(start, i - 1)
  }

  /** Each Sentry.capture* call, as source text. */
  function captureCalls(source: string): string[] {
    const found: string[] = []
    const re = /Sentry\.capture(?:Exception|Message|Event)\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(source))) {
      let depth = 1
      let i = m.index + m[0].length
      for (; i < source.length && depth > 0; i++) {
        if (source[i] === '(') depth++
        else if (source[i] === ')') depth--
      }
      found.push(source.slice(m.index, i))
    }
    return found
  }

  function offensesIn(source: string): string[] {
    const offenses: string[] = []
    for (const call of captureCalls(source)) {
      const where = call.replace(/\s+/g, ' ').slice(0, 160)
      for (const key of ['extra', 'contexts']) {
        if (FORBIDDEN_KEY.test(objectAfter(call, key))) offenses.push(`${key} names customer data: ${where}`)
      }
      if (/\bwebhook_url\s*:/.test(call)) offenses.push(`tags a receiver's full URL: ${where}`)
    }
    return offenses
  }

  it('catches a report that attaches a row or a receiver URL', () => {
    const offending = `
      Sentry.captureException(err, {
        tags: { trigger_id: trigger.id, action_type: trigger.actionType },
        extra: { projectId, event },
      })
      Sentry.captureException(err, {
        tags: { trigger_id: trigger.id, webhook_url: trigger.webhookUrl, project_id: projectId },
        extra: { event, attempts, lastStatusCode },
      })`
    expect(offensesIn(offending)).toHaveLength(3)
  })

  it('reads the real capture calls', () => {
    expect(captureCalls(read('lib/services/trigger-service.ts')).length).toBeGreaterThan(0)
  })

  it('attaches no context under a name that carries customer data', () => {
    const offenders: string[] = []
    for (const file of [...sources('lib'), ...sources('app'), ...sources('server'), ...sources('components')]) {
      for (const offense of offensesIn(read(file))) offenders.push(`${file}: ${offense}`)
    }
    expect(offenders).toEqual([])
  })
})
