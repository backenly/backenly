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

import {
  SseReader,
  clockOffsetFromDate,
  connectingFetch,
  describeError,
  describesTable,
  freshStatus,
  generatedFunctionsFor,
  parseArgs,
  pendingApproval,
  qualify,
  toolBody,
  toolData,
  untilAnswering,
} from '@/scripts/qualify-region'

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
    expect(args.repairWaitMinutes).toBe(6)
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
    expect(parseArgs([...ARGV, '--repair-wait-minutes', '12'], ENV).repairWaitMinutes).toBe(12)
    expect(() => parseArgs([...ARGV, '--repair-wait-minutes', '0'], ENV)).toThrow(/--repair-wait-minutes/)
    expect(() => parseArgs([...ARGV, '--repair-wait-minutes', '61'], ENV)).toThrow(/--repair-wait-minutes/)
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

  it('qualifies the home region through the home host, and only there', () => {
    const home = ['--project', PROJECT, '--region', 'ap-south-1', '--api', 'https://staging.example.com',
      '--home', 'https://staging.example.com', '--operator', 'qualify-operator@example.com']
    expect(parseArgs(home, ENV)).toMatchObject({ region: 'ap-south-1' })
    expect(parseArgs(home, ENV).api.origin).toBe('https://staging.example.com')
    const elsewhere = [...home]
    elsewhere[elsewhere.indexOf('--api') + 1] = 'https://ap-south-1.api.staging.example.com'
    expect(() => parseArgs(elsewhere, ENV)).toThrow(/must be the home host/)
  })

  it('runs the rollback drills, with what each needs from the run', () => {
    const plain = parseArgs(ARGV, ENV)
    // Without a member or a kill command those two drills are not run, and say so.
    expect(plain).toMatchObject({ freshnessSeconds: 30, skipDeletionDrill: false, member: null, killCommand: null, killAfterSeconds: 8, killDrainSeconds: 70, settleWaitMinutes: 30 })

    expect(parseArgs([...ARGV, '--freshness-seconds', '45'], ENV).freshnessSeconds).toBe(45)
    expect(() => parseArgs([...ARGV, '--freshness-seconds', '0'], ENV)).toThrow(/--freshness-seconds/)
    expect(parseArgs([...ARGV, '--skip-deletion-drill'], ENV).skipDeletionDrill).toBe(true)

    // The member's password, like the operator's, comes from the environment only.
    const member = [...ARGV, '--member', 'qualify-member@example.com']
    const memberEnv = { ...ENV, BACKENLY_QUALIFY_MEMBER_PASSWORD: 'not-a-real-member-password' }
    expect(parseArgs(member, memberEnv).member).toEqual({ email: 'qualify-member@example.com', password: memberEnv.BACKENLY_QUALIFY_MEMBER_PASSWORD, totp: null })
    expect(() => parseArgs(member, ENV)).toThrow(/BACKENLY_QUALIFY_MEMBER_PASSWORD must/)
    expect(() => parseArgs([...member, '--member-password', 'x'], memberEnv)).toThrow(/BACKENLY_QUALIFY_MEMBER_PASSWORD only/)
    expect(() => parseArgs([...ARGV, '--member', 'qualify-operator@example.com'], memberEnv)).toThrow(/must not be the operator/)
    expect(() => parseArgs([...ARGV, '--member', 'not-an-email'], memberEnv)).toThrow(/--member takes an email/)
    expect(parseArgs(member, { ...memberEnv, BACKENLY_QUALIFY_MEMBER_TOTP: '654321' }).member?.totp).toBe('654321')

    const kill = parseArgs([...ARGV, '--kill-command', 'aws ecs stop-task --cluster c --task t', '--kill-after-seconds', '5', '--settle-wait-minutes', '40'], ENV)
    expect(kill).toMatchObject({ killCommand: 'aws ecs stop-task --cluster c --task t', killAfterSeconds: 5, settleWaitMinutes: 40 })
    expect(() => parseArgs([...ARGV, '--kill-after-seconds', '0'], ENV)).toThrow(/--kill-after-seconds/)
    expect(() => parseArgs([...ARGV, '--settle-wait-minutes', '0'], ENV)).toThrow(/--settle-wait-minutes/)
    // The wait after the kill fits the environment's drain and stop timeout; 0 is allowed, for an abrupt kill.
    expect(parseArgs([...ARGV, '--kill-drain-seconds', '0'], ENV).killDrainSeconds).toBe(0)
    expect(parseArgs([...ARGV, '--kill-drain-seconds', '120'], ENV).killDrainSeconds).toBe(120)
    expect(() => parseArgs([...ARGV, '--kill-drain-seconds', '601'], ENV)).toThrow(/--kill-drain-seconds/)
    expect(() => parseArgs([...ARGV, '--kill-drain-seconds', '-1'], ENV)).toThrow(/--kill-drain-seconds/)
  })

  it('names projects of other regions for the region host to refuse, and nothing else', () => {
    const HOME_PROBE = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
    const OREGON_PROBE = '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a'
    // Without --foreign the check is not run, and the report says so.
    expect(parseArgs(ARGV, ENV).foreign).toEqual([])
    expect(parseArgs([...ARGV, '--foreign', `${HOME_PROBE}@ap-south-1, ${OREGON_PROBE}@us-west-2`], ENV).foreign).toEqual([
      { project: HOME_PROBE, region: 'ap-south-1' },
      { project: OREGON_PROBE, region: 'us-west-2' },
    ])
    expect(() => parseArgs([...ARGV, '--foreign', HOME_PROBE], ENV)).toThrow(/<project id>@<region>/)
    expect(() => parseArgs([...ARGV, '--foreign', `not-a-uuid@ap-south-1`], ENV)).toThrow(/<project id>@<region>/)
    expect(() => parseArgs([...ARGV, '--foreign', `${HOME_PROBE}@mars-north-1`], ENV)).toThrow(/not a Backenly Cloud region/)
    // A project of the region being qualified would prove nothing about isolation.
    expect(() => parseArgs([...ARGV, '--foreign', `${HOME_PROBE}@us-east-1`], ENV)).toThrow(/the region being qualified/)
    expect(() => parseArgs([...ARGV, '--foreign', `${PROJECT}@ap-south-1`], ENV)).toThrow(/must not name the probe project/)
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

describe('fresh connections, after a kill', () => {
  let server: http.Server
  let port: number
  let connections = 0
  /** The statuses the server answers with, in order; 200 once they run out. */
  let script: number[] = []

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(script.shift() ?? 200)
      res.end()
    })
    server.on('connection', () => connections++)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('asks on a connection of its own every time, so a draining one is never reused', async () => {
    script = []
    const before = connections
    expect(await freshStatus(`http://127.0.0.1:${port}/api/health`)).toBe(200)
    expect(await freshStatus(`http://127.0.0.1:${port}/api/health`)).toBe(200)
    expect(connections - before).toBe(2)
  })

  it('goes where --connect says and keeps the hostname, and reads nothing answering as 0', async () => {
    script = [503]
    expect(await freshStatus(`http://home.test:${port}/api/health`, { 'home.test': '127.0.0.1' })).toBe(503)
    const closed = http.createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const gone = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    expect(await freshStatus(`http://127.0.0.1:${gone}/api/health`)).toBe(0)
  })

  it('waits for answers in a row, not for one answer between refusals', async () => {
    script = [503, 200, 503, 200]
    const before = connections
    await untilAnswering(`http://127.0.0.1:${port}/api/health`, {}, { consecutive: 2, byMs: Date.now() + 10_000, intervalMs: 1 })
    // 503, 200, 503, then the two in a row.
    expect(connections - before).toBe(5)
  })

  it('gives up at its deadline, saying what it last got', async () => {
    script = Array(50).fill(503)
    await expect(
      untilAnswering(`http://127.0.0.1:${port}/api/health`, {}, { consecutive: 2, byMs: Date.now() + 50, intervalMs: 5 }),
    ).rejects.toThrow(/did not answer 2 fresh connections in a row \(the last got 503\)/)
    script = []
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

describe('tool answers', () => {
  // Every tool answers { ok, summary, data }: the approval for check_approval,
  // the table for get_table_schema, the new key for create_api_key.
  it('reads data from the structured result, or from the JSON text', () => {
    const key = `proj_live_${'a'.repeat(64)}`
    expect(toolData({ text: '', structured: { ok: true, summary: 'Created', data: { apiKey: key, keyId: 'k1' } } })).toEqual({ apiKey: key, keyId: 'k1' })
    expect(toolData({ text: JSON.stringify({ ok: true, data: { status: 'executed' } }), structured: null })).toEqual({ status: 'executed' })
  })

  it('answers null when there is no data object', () => {
    expect(toolData({ text: 'Approval 1234… is pending.', structured: null })).toBeNull()
    expect(toolData({ text: '', structured: { ok: true, summary: 'Done.' } })).toBeNull()
  })

  it('reads a refused call\'s whole body, where its code and the change it recorded are', () => {
    const refused = { ok: false, code: 'MIGRATION_FAILED', recovered: true, change: { seq: 7, status: 'recovered' } }
    expect(toolBody({ text: 'Migration failed part-way', structured: refused })).toEqual(refused)
    expect(toolBody({ text: JSON.stringify(refused), structured: null })).toEqual(refused)
    expect(toolBody({ text: 'not JSON', structured: null })).toBeNull()
  })
})

describe('what an agent reads about a table', () => {
  // The schema section as staging answered it after a restore removed
  // qualify_kept_4e3a9bbd: the table is gone, its generated endpoint is not.
  const afterRestore = {
    projectId: '13eab7a0-5e15-4714-b3c5-aba760004421',
    tables: [{ name: 'qualify_notes', recordCount: 5 }, { name: 'users', recordCount: 2 }],
    relationships: [],
    realtime: { tables: ['qualify_notes'] },
    functions: { count: 3, names: ['qualify-ping', 'qualify_notes-schema', 'qualify_kept_4e3a9bbd-schema'] },
  }

  it('describes a table only where the table itself is named, never by a function named after it', () => {
    expect(describesTable(afterRestore, 'qualify_notes')).toBe(true)
    expect(describesTable(afterRestore, 'qualify_kept_4e3a9bbd')).toBe(false)
  })

  it('still sees a table that lingers in relationships or realtime', () => {
    expect(describesTable({ ...afterRestore, realtime: { tables: ['qualify_kept_4e3a9bbd'] } }, 'qualify_kept_4e3a9bbd')).toBe(true)
    expect(
      describesTable(
        { ...afterRestore, relationships: [{ from: 'qualify_kept_4e3a9bbd', column: 'note_id', to: 'qualify_notes', toColumn: 'id' }] },
        'qualify_kept_4e3a9bbd',
      ),
    ).toBe(true)
  })

  it('matches whole names: a table is not described by another whose name starts the same', () => {
    expect(describesTable({ tables: [{ name: 'qualify_kept_4e3a9bbd_old' }] }, 'qualify_kept_4e3a9bbd')).toBe(false)
  })

  it('lists the functions generated for a table, and only those', () => {
    expect(generatedFunctionsFor(afterRestore, 'qualify_kept_4e3a9bbd')).toEqual(['qualify_kept_4e3a9bbd-schema'])
    expect(generatedFunctionsFor(afterRestore, 'qualify')).toEqual(['qualify-ping'])
    expect(generatedFunctionsFor(afterRestore, 'users')).toEqual([])
    expect(generatedFunctionsFor({ tables: [] }, 'users')).toEqual([])
  })
})

describe('the service clock', () => {
  it('measures how far this machine is behind the service from its Date header', () => {
    // A machine 3.5 min slow: the header says 19:05:30, the request took 200 ms.
    const sent = Date.parse('2026-10-19T19:02:00.000Z')
    const offset = clockOffsetFromDate('Mon, 19 Oct 2026 19:05:30 GMT', sent, sent + 200)
    expect(offset).toBe(210_000 + 500 - 100)
  })

  it('leaves this machine in charge when the header is missing or unreadable', () => {
    expect(clockOffsetFromDate(null, 1_000, 1_200)).toBe(0)
    expect(clockOffsetFromDate('soon', 1_000, 1_200)).toBe(0)
  })
})

describe('a failure in the report', () => {
  it('keeps an error\'s code and status beside its message', () => {
    const err = Object.assign(new Error('Executable files are not allowed.'), { code: 'VALIDATION_ERROR', status: 400 })
    expect(describeError(err)).toBe('Executable files are not allowed. (VALIDATION_ERROR 400)')
    expect(describeError(new Error('plain'))).toBe('plain')
  })

  it('shows anything that is not an Error as JSON, never "[object Object]"', () => {
    expect(describeError({ error: { code: 'VALIDATION_ERROR' } })).toBe('{"error":{"code":"VALIDATION_ERROR"}}')
    expect(describeError('text')).toBe('"text"')
    expect(describeError(undefined)).toBe('undefined')
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
    for (const check of [
      'change', 'undone', 'snapshot', 'download-from-region', 'restore', 'serves-after-restore', 'functions-after-restore',
      'nothing-waiting', 'recovered-after-failing-part-way', 'recovered-after-failing-verification', 'served-after-a-change',
      'agent-asks-a-person-decides', 'restore-needs-a-person', 'restored-with-acknowledgement', 'reapplied-and-served',
      'restore-refused-under-a-later-change', 'drill-tables-removed', 'deleted-with-its-history',
      // What a coding agent reads of the schema, after each of them.
      'described-after-undo', 'described-after-a-change', 'described-after-acknowledged-restore', 'described-after-reapply',
      // And the functions generated for a table: gone when a restore removed it, back when a reapply returned it.
      'functions-after-undo', 'functions-after-acknowledged-restore', 'functions-after-reapply', 'functions-after-drill-restores',
    ]) {
      expect([check, status(check)]).toEqual([check, 'skip'])
    }
    expect(results.filter((r) => r.status === 'pass')).toEqual([])
    expect(lines.join('\n')).toContain('REGION NOT QUALIFIED')
    // The drills a run was not given what they need for are named, not passed.
    expect(lines.join('\n')).toMatch(/Not run here: .*--member not given.*--kill-command not given/)
    expect(lines.join('\n')).toMatch(/Not run here: .*cross-region isolation at the region host: --foreign named no project/)
    // No key or password ever reaches the output.
    expect(lines.join('\n')).not.toMatch(/mcp_live_test|proj_live_test|not-a-real-operator-password/)
  }, 60_000)

  it('fails, never passes, the refusal of another region\'s project it could not ask for', async () => {
    const closed = await new Promise<number>((resolve) => {
      const s = http.createServer()
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port
        s.close(() => resolve(p))
      })
    })
    const HOME_PROBE = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
    const args = parseArgs(
      [
        '--project', PROJECT,
        '--region', 'us-east-1',
        '--api', `https://us-east-1.api.staging.example.com:${closed}`,
        '--home', `https://staging.example.com:${closed}`,
        '--connect', 'us-east-1.api.staging.example.com=127.0.0.1,staging.example.com=127.0.0.1',
        '--operator', 'qualify-operator@example.com',
        '--foreign', `${HOME_PROBE}@ap-south-1`,
        '--skip-revocation', '--skip-deletion-drill',
      ],
      ENV,
    )
    const lines: string[] = []
    const { ok, results } = await qualify(args, (line) => lines.push(line))
    expect(ok).toBe(false)
    expect(results.find((r) => r.check === 'refuses-ap-south-1-project')?.status).toBe('fail')
    expect(lines.join('\n')).not.toContain('cross-region isolation at the region host')
  }, 60_000)
})
