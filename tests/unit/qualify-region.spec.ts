/**
 * THE REGIONAL QUALIFICATION SUITE (scripts/qualify-region.ts)
 * ============================================================
 * The suite's own first real run is against a region, so what can be proved
 * here is proved here: it refuses arguments that would test the wrong thing or
 * leak a key, its transport reaches a load balancer while keeping the real
 * hostname, its event-stream parser handles the stream as servers send it, it
 * recognises a call parked for a person's approval, and a region it cannot
 * reach fails the run cleanly, check by check, instead of passing by default.
 */

// The suite runs on the runtime's real Request and Response, as the MCP SDK and
// the transport need; jest.setup.js replaces them with stand-ins otherwise.
import '../helpers/real-web-standard'

import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { SseReader, connectingFetch, parseArgs, pendingApproval, qualify } from '@/scripts/qualify-region'

const PROJECT = '0b9e3a52-7a5d-4c1e-9a2b-1f2e3d4c5b6a'
const ENV = {
  BACKENLY_QUALIFY_MCP_KEY: 'mcp_live_test',
  BACKENLY_QUALIFY_PROJECT_KEY: 'proj_live_test',
  BACKENLY_QUALIFY_OPERATOR_PASSWORD: 'not-a-real-operator-password',
}
const ARGV = [
  '--project', PROJECT,
  '--region', 'us-east-1',
  '--api', 'https://us-east-1.api.staging.example.com',
  '--home', 'https://staging.example.com',
  '--operator', 'qualify-operator@example.com',
]

describe('arguments', () => {
  it('reads a complete run', () => {
    const args = parseArgs([...ARGV, '--connect', 'us-east-1.api.staging.example.com=alb-1.example.net,Staging.Example.com=alb-2.example.net', '--report', 'r.json'], ENV)
    expect(args.project).toBe(PROJECT)
    expect(args.api.origin).toBe('https://us-east-1.api.staging.example.com')
    expect(args.connect).toEqual({ 'us-east-1.api.staging.example.com': 'alb-1.example.net', 'staging.example.com': 'alb-2.example.net' })
    expect(args.report).toBe('r.json')
    expect(args.skipRevocation).toBe(false)
    expect(args.approvalWaitMinutes).toBe(10)
    expect(args.jobWaitMinutes).toBe(15)
    expect(args.operator).toBe('qualify-operator@example.com')
    expect(args.operatorPassword).toBe(ENV.BACKENLY_QUALIFY_OPERATOR_PASSWORD)
    expect(args.operatorTotp).toBeNull()
  })

  it('takes keys from the environment only', () => {
    expect(() => parseArgs([...ARGV, '--mcp-key', 'mcp_live_x'], ENV)).toThrow(/never from the command line/)
    expect(() => parseArgs([...ARGV, '--project-key', 'proj_live_x'], ENV)).toThrow(/never from the command line/)
    expect(() => parseArgs(ARGV, { ...ENV, BACKENLY_QUALIFY_MCP_KEY: undefined })).toThrow(/BACKENLY_QUALIFY_MCP_KEY/)
    expect(() => parseArgs(ARGV, { ...ENV, BACKENLY_QUALIFY_PROJECT_KEY: 'svc_live_x' })).toThrow(/publishable key/)
  })

  it('signs in an operator, whose password comes from the environment only', () => {
    expect(() => parseArgs([...ARGV, '--operator-password', 'x'], ENV)).toThrow(/BACKENLY_QUALIFY_OPERATOR_PASSWORD only/)
    expect(() => parseArgs([...ARGV, '--password', 'x'], ENV)).toThrow(/BACKENLY_QUALIFY_OPERATOR_PASSWORD only/)
    expect(() => parseArgs(ARGV, { ...ENV, BACKENLY_QUALIFY_OPERATOR_PASSWORD: undefined })).toThrow(/BACKENLY_QUALIFY_OPERATOR_PASSWORD must/)
    // Recovery and rollback cannot be left out by leaving the operator out.
    const without = ARGV.slice(0, ARGV.indexOf('--operator'))
    expect(() => parseArgs(without, ENV)).toThrow(/--operator <email> is required/)
    expect(() => parseArgs([...without, '--operator', 'not-an-email'], ENV)).toThrow(/--operator <email> is required/)
    expect(parseArgs(ARGV, { ...ENV, BACKENLY_QUALIFY_OPERATOR_TOTP: ' 123456 ' }).operatorTotp).toBe('123456')
    expect(() => parseArgs(ARGV, { ...ENV, BACKENLY_QUALIFY_OPERATOR_TOTP: '12345' })).toThrow(/six-digit/)
    expect(parseArgs([...ARGV, '--job-wait-minutes', '30'], ENV).jobWaitMinutes).toBe(30)
    expect(() => parseArgs([...ARGV, '--job-wait-minutes', '0'], ENV)).toThrow(/--job-wait-minutes/)
  })

  it('refuses a run that would not test the region', () => {
    const swap = (flag: string, value: string) => {
      const argv = [...ARGV]
      argv[argv.indexOf(flag) + 1] = value
      return argv
    }
    expect(() => parseArgs(swap('--api', 'https://api.staging.example.com'), ENV)).toThrow(/region's host/)
    expect(() => parseArgs(swap('--api', 'http://us-east-1.api.staging.example.com'), ENV)).toThrow(/https/)
    expect(() => parseArgs(swap('--home', 'https://us-east-1.api.staging.example.com'), ENV)).toThrow(/same host/)
    expect(() => parseArgs(swap('--region', 'mars-north-1'), ENV)).toThrow(/Backenly Cloud region/)
    expect(() => parseArgs(swap('--project', 'not-a-uuid'), ENV)).toThrow(/--project/)
    expect(() => parseArgs([...ARGV, '--connect', 'host-without-target'], ENV)).toThrow(/host=target/)
    expect(() => parseArgs([...ARGV, '--surprise', 'x'], ENV)).toThrow(/unknown option/)
  })
})

describe('the transport', () => {
  let server: http.Server
  let port: number
  const seen: Array<{ host?: string; url?: string; method?: string; body: string }> = []

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      seen.push({ host: req.headers.host, url: req.url, method: req.method, body })
      res.setHeader('x-answered-by', 'balancer')
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('connects to the target and keeps the hostname', async () => {
    const f = connectingFetch({ 'region.test': '127.0.0.1' })
    const res = await f(`http://region.test:${port}/api/v1/p/db?limit=1`, { method: 'POST', headers: { 'x-api-key': 'k' }, body: 'hello' })
    expect(res.status).toBe(201)
    expect(res.headers.get('x-answered-by')).toBe('balancer')
    expect(await res.json()).toEqual({ ok: true })
    expect(seen.at(-1)).toEqual({ host: `region.test:${port}`, url: '/api/v1/p/db?limit=1', method: 'POST', body: 'hello' })
  })

  it('leaves every other host to the ordinary fetch', async () => {
    const calls: string[] = []
    const base = (async (input: RequestInfo | URL) => {
      calls.push(new Request(input as any).url)
      return new Response('base')
    }) as typeof fetch
    const f = connectingFetch({ 'region.test': '127.0.0.1' }, base)
    expect(await (await f('https://elsewhere.test/x')).text()).toBe('base')
    expect(calls).toEqual(['https://elsewhere.test/x'])
  })
})

describe('the event stream', () => {
  it('assembles events across chunks, as servers send them', () => {
    const r = new SseReader()
    expect(r.push(': keep-alive\n\ndata: {"type":"conn')).toEqual([])
    expect(r.push('ected"}\n\nevent: custom\r\ndata: line one\r\ndata: line two\r\n\r\n')).toEqual([
      { event: 'message', data: '{"type":"connected"}' },
      { event: 'custom', data: 'line one\nline two' },
    ])
  })
})

describe('parked calls', () => {
  it('finds a pending approval in the structured result or the text', () => {
    expect(pendingApproval({ text: '', structured: { approval: { id: 'apr_1', status: 'pending' } } })).toBe('apr_1')
    expect(pendingApproval({ text: JSON.stringify({ approval: { id: 'apr_2', status: 'pending' } }), structured: null })).toBe('apr_2')
    expect(pendingApproval({ text: JSON.stringify({ approval: { id: 'apr_3', status: 'executed' } }), structured: null })).toBeNull()
    expect(pendingApproval({ text: 'Created the table.', structured: null })).toBeNull()
  })
})

describe('a region that cannot be reached', () => {
  it('fails the run check by check, and skips what depends on a failure', async () => {
    // A port nothing listens on: every connection is refused at once.
    const closed = await new Promise<number>((resolve) => {
      const s = http.createServer()
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port
        s.close(() => resolve(p))
      })
    })
    const args = parseArgs(
      [
        '--project', PROJECT,
        '--region', 'us-east-1',
        '--api', `https://us-east-1.api.staging.example.com:${closed}`,
        '--home', `https://staging.example.com:${closed}`,
        '--connect', 'us-east-1.api.staging.example.com=127.0.0.1,staging.example.com=127.0.0.1',
        '--operator', 'qualify-operator@example.com',
        '--skip-revocation',
      ],
      ENV,
    )
    const originalFetch = globalThis.fetch
    const lines: string[] = []
    const { ok, results } = await qualify(args, (line) => lines.push(line))

    expect(ok).toBe(false)
    expect(globalThis.fetch).toBe(originalFetch)
    const status = (check: string) => results.find((r) => r.check === check)?.status
    expect(status('health')).toBe('fail')
    expect(status('sign-in')).toBe('fail')
    expect(status('connect')).toBe('fail')
    expect(status('table')).toBe('skip')
    expect(status('v1-own-rows-only')).toBe('skip')
    // Recovery and rollback are skipped as unproven, never passed.
    for (const check of ['change', 'undone', 'snapshot', 'download-from-region', 'restore', 'serves-after-restore', 'functions-after-restore']) {
      expect([check, status(check)]).toEqual([check, 'skip'])
    }
    expect(results.filter((r) => r.status === 'pass')).toEqual([])
    expect(lines.join('\n')).toContain('REGION NOT QUALIFIED')
    // No key or password ever reaches the output.
    expect(lines.join('\n')).not.toMatch(/mcp_live_test|proj_live_test|not-a-real-operator-password/)
  }, 60_000)
})
