/**
 * The functions docs describe what the runtime actually hands a function
 * (production QA 2026-11-09, report 45).
 *
 * An agent read that variables are "available inside AI functions as
 * ctx.env.KEY", found an http function sees them in process.env instead, and
 * deployed a throwaway function to learn what a row event carries. These read
 * the code that builds each event and the http function's environment, and
 * check the docs say the same.
 */

import fs from 'fs'
import path from 'path'

const read = (file: string) => fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8')
const docs = read('public/docs/agents/functions.md')
const connectDocs = read('public/docs/agents/connect.md')

describe('the functions docs match the runtime', () => {
  it('name every row event type the capture hands a function', () => {
    const capture = read('lib/webhooks/capture.ts')
    const table = capture.slice(capture.indexOf('const FUNCTION_EVENT_FOR_OPERATION'))
    const types = [...table.slice(0, table.indexOf('}')).matchAll(/:\s*'([a-z]+)'/g)].map((m) => m[1])
    expect(types).toEqual(['insert', 'update', 'delete'])
    expect(capture).toMatch(/const event = \{ type, table: row\.table_name, data: row\.row_data \?\? \{\}, \.\.\.\(row\.old_data \? \{ old: row\.old_data \} : \{\}\) \}/)
    expect(docs).toContain('a row trigger: `{ type, table, data, old }`. `type` is `"insert"`, `"update"` or `"delete"`')
  })

  it('give the sign-up event the fields every sign-up path sends', () => {
    // Password, OAuth and magic-link sign-ups all go through emitEndUserCreated,
    // which fires on_signup functions with these fields (#599).
    expect(read('lib/services/end-user-auth-events.ts')).toContain('fireAiFunctionsOnSignup(projectId, { id: user.id, email: user.email, name: user.name })')
    expect(docs).toContain('`on_signup`: `{ type: "signup", data: { id, email, name } }`')
  })

  it('give the schedule event the fields the runner sends', () => {
    const runner = read('lib/services/cron-runner.ts')
    expect(runner).toContain("type: 'cron',")
    expect(runner).toContain('data: { scheduledAt: ts.toISOString(), timestamp: ts.getTime() },')
    expect(docs).toContain('a schedule: `{ type: "cron", data: { scheduledAt, timestamp } }`')
  })

  it('name the modules the runner gives an http function, as does the prompt that writes them', () => {
    // A module named in one place and missing from another is code the model
    // writes that crashes, or a helper nobody learns exists. The runner also
    // serves the paths functions imported before @backenly/functions, so code
    // deployed with them keeps running, and nothing names those any more.
    const runner = read('lib/services/ai-functions/isolation/function-runner.cjs')
    const loader = runner.slice(runner.indexOf('function buildRequire('))
    const served = [...loader.slice(0, loader.indexOf('default:')).matchAll(/case '([^']+)':/g)]
      .map((m) => m[1])
      .filter((id) => !id.startsWith('node:'))
    const named = runner.match(/const ROUTE_MODULES_ALLOWED =\s*'([^']*)'/)![1].replace(/ \([^)]*\)/g, '').split(', ')
    expect(loader.slice(0, loader.indexOf('\n}\n'))).toContain('Allowed: ${ROUTE_MODULES_ALLOWED}')
    expect(named).toEqual(['@backenly/functions', 'crypto', 'bcryptjs', 'jsonwebtoken'])
    expect(served).toEqual([...named, 'next/server', '@/lib/db', '@/lib/auth/jwt', '@/lib/auth/session'])

    const contract = read('lib/ai/function-generator.ts')
    const promptLine = contract.slice(contract.indexOf('- Imports allowed ONLY from:')).split('\n')[0]
    expect([...promptLine.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual(named)

    // The docs offer exactly the modules the runner names, in its order. They
    // taught the earlier paths (next/server, @/lib/db) and never mentioned
    // @backenly/functions, which is what Backenly's own builder writes
    // (production QA, 2026-11-27).
    const docsLine = docs.slice(docs.indexOf('It may import only')).split('\n')[0]
    const backticked = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1])
    expect(backticked(docsLine.slice(0, docsLine.indexOf('. ')))).toEqual(named)
    // The earlier paths are named once, as what a function already deployed
    // with them still runs on, and they are all of what the runner still serves.
    const earlier = docsLine.slice(docsLine.indexOf('A function deployed with the earlier imports'))
    expect(backticked(earlier)).toEqual(served.filter((id) => !named.includes(id)))
    // Everything the module hands a function is named.
    const functionsModule = runner.slice(runner.indexOf('function makeFunctionsModule('))
    const given = [...functionsModule.slice(0, functionsModule.indexOf('})')).matchAll(/^\s+([a-zA-Z]+)[:,]/gm)]
      .map((m) => m[1])
      .filter((name) => !['Response', 'Request', 'Headers'].includes(name))
    expect(given).toEqual(['db', 'asService', 'verifyToken', 'isAdminRequest', 'createSession'])
    for (const name of given) expect(docsLine).toContain(`\`${name}\``)
    // And the example is written the way the docs say to write one.
    expect(docs).toContain("import { db } from '@backenly/functions'")
    expect(docs).toContain('return Response.json({ rows })')
    expect(docs).not.toMatch(/from '(next\/server|@\/lib\/[^']+)'/)
    expect(docs).not.toContain('NextResponse')
  })

  it('say the change history keeps the code a redeploy replaced, as the deploy answer does', () => {
    // The docs said "there is no version history, so there is nothing to roll
    // back to" while History kept the earlier code (production QA, 2026-11-27).
    const note = read('lib/services/ai-functions/previous-code.ts')
    expect(note).toContain('The previous code is kept in the change history as change #')
    expect(note).toContain('deploy { action: "revert_change", changeId: ')
    expect(docs).toContain('the change history keeps the code it replaced')
    expect(docs).toContain('`deploy { action: "revert_change", changeId }`')
    expect(docs).not.toMatch(/no version history|nothing to roll back/)
    expect(read('lib/ai/brain/tools.ts')).not.toMatch(/no version history/)
  })

  it('say an http function reads the project’s variables from process.env', () => {
    // A route module's process.env is built in its runner process.
    const runner = read('lib/services/ai-functions/isolation/function-runner.cjs')
    expect(runner).toContain('function makeCuratedProcess(')
    const curated = runner.slice(runner.indexOf('function makeCuratedProcess('))
    expect(curated.slice(0, curated.indexOf('\n}\n'))).toContain('...projectEnv')
    expect(docs).toContain('`process.env` holds this project\'s variables')
    expect(connectDocs).toContain('http functions read as `process.env.KEY`')
  })
})
