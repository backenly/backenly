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
