/**
 * PLAN VOCABULARY + REQUIREMENTS LEDGER SUITE
 * ===========================================
 * Locks in the two accountability layers added after the Founder-Outreach
 * regression:
 *
 *   1. validate.ts can express functions / crons / seeds — "when X do Y"
 *      automations and demo data are plan steps, not silently dropped asks.
 *   2. ledger.ts extracts what the user requested and reconciles it against
 *      what was applied — deterministically, no LLM self-grading.
 *
 * All pure — no DB, no network.
 */

import { validateAndEnrichSpec } from '../../lib/ai/blueprints/validate'
import {
  extractRequirements,
  appliedStateFromSteps,
  reconcileLedger,
  renderLedgerReport,
} from '../../lib/ai/blueprints/ledger'
import type { BlueprintStep } from '../../lib/ai/blueprints/types'

// ── validate.ts: new vocabulary ──────────────────────────────────────────────

function baseSpec() {
  return {
    domain: 'outreach-crm',
    title: 'Founder Outreach Backend',
    needsAuth: true,
    tables: [
      {
        name: 'contacts',
        columns: [
          { name: 'user_id', type: 'uuid' },
          { name: 'name', type: 'text' },
          { name: 'status', type: 'text' },
        ],
      },
      {
        name: 'followups',
        columns: [
          { name: 'user_id', type: 'uuid' },
          { name: 'contact_id', type: 'uuid', fkTo: 'contacts' },
          { name: 'title', type: 'text' },
          { name: 'due_date', type: 'timestamp' },
        ],
      },
    ],
    rls: [
      { tableName: 'contacts', policy: 'owner_read_write' },
      { tableName: 'followups', policy: 'owner_read_write' },
    ],
  }
}

describe('validateAndEnrichSpec — functions / crons / seeds vocabulary', () => {
  it('emits generate_function steps for row-event automations', () => {
    const result = validateAndEnrichSpec({
      ...baseSpec(),
      functions: [
        {
          name: 'create_followup_after_send',
          description: 'When a contact status changes to email_sent, insert a followups row due in 5 days.',
          trigger: 'on_update',
          table: 'contacts',
        },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const fnSteps = result.blueprint.steps.filter(s => s.tool === 'generate_function')
    expect(fnSteps).toHaveLength(1)
    expect(fnSteps[0].args).toMatchObject({
      name: 'create_followup_after_send',
      trigger: 'on_update',
      table: 'contacts',
    })
  })

  it('drops row-event functions whose table does not exist, keeps http functions', () => {
    const result = validateAndEnrichSpec({
      ...baseSpec(),
      functions: [
        { name: 'ghost_fn', description: 'Automation on a table that was never specced out.', trigger: 'on_insert', table: 'nonexistent' },
        { name: 'export_contacts', description: 'HTTP endpoint that exports all contacts as CSV.', trigger: 'http', method: 'get' },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const fnSteps = result.blueprint.steps.filter(s => s.tool === 'generate_function')
    expect(fnSteps).toHaveLength(1)
    expect(fnSteps[0].args).toMatchObject({ name: 'export_contacts', trigger: 'http', method: 'GET' })
  })

  it('emits create_cron_job steps and drops malformed ones', () => {
    const result = validateAndEnrichSpec({
      ...baseSpec(),
      crons: [
        { description: 'Mark followups overdue when due_date is in the past.', schedule: 'every hour' },
        { description: 'short', schedule: '' },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const cronSteps = result.blueprint.steps.filter(s => s.tool === 'create_cron_job')
    expect(cronSteps).toHaveLength(1)
    expect(cronSteps[0].args).toMatchObject({ schedule: 'every hour' })
  })

  it('emits seed_rows steps LAST, clamped to spec columns with FK/user_id stripped', () => {
    const result = validateAndEnrichSpec({
      ...baseSpec(),
      seeds: [
        {
          tableName: 'contacts',
          rows: [
            { name: 'Ava Chen', status: 'email_sent', user_id: 'llm-invented', bogus_col: 'x' },
            { name: 'Sam Ortiz', status: 'replied' },
          ],
        },
        { tableName: 'unknown_table', rows: [{ a: 1 }] },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const steps = result.blueprint.steps
    const seedSteps = steps.filter(s => s.tool === 'seed_rows')
    expect(seedSteps).toHaveLength(1)
    // Seeds are the final steps — automations must exist before demo rows fire them.
    expect(steps[steps.length - 1].tool).toBe('seed_rows')
    const rows = (seedSteps[0].args as { rows: Array<Record<string, unknown>> }).rows
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ name: 'Ava Chen', status: 'email_sent' }) // user_id + bogus_col stripped
  })
})

// ── ledger.ts: extraction ────────────────────────────────────────────────────

const OUTREACH_PROMPT = `Build the backend for a SaaS app called Founder Outreach OS.

Create a complete backend with authentication, storage, realtime updates and dashboard analytics.

Create these tables:

1. contacts
- user_id
- name
- status: not_contacted, email_sent, replied
- next_followup_at
- created_at
- updated_at

2. followups
- user_id
- contact_id
- title
- due_date
- status: pending, completed, overdue

Create API endpoints for:
- create, read, update, delete contacts
- upload and fetch documents

Add automation:
1. When a contact status changes to email_sent, automatically create a follow-up due in 5 days.
2. When any status changes, insert a row into status_history.

Add realtime:
- realtime updates for contacts
- realtime updates for followups

Seed demo data:
- 10 investor contacts
`

describe('extractRequirements', () => {
  const ledger = extractRequirements(OUTREACH_PROMPT)

  it('extracts numbered tables with their columns (implicit columns excluded)', () => {
    expect(ledger.tables.map(t => t.name)).toEqual(['contacts', 'followups'])
    expect(ledger.tables[0].columns).toEqual(['user_id', 'name', 'status', 'next_followup_at'])
  })

  it('does not absorb prose bullets ("create, read, update…") as columns', () => {
    const all = ledger.tables.flatMap(t => t.columns)
    expect(all).not.toContain('create')
    expect(all).not.toContain('upload')
  })

  it('extracts "when …" automations', () => {
    expect(ledger.automations).toHaveLength(2)
    expect(ledger.automations[0]).toMatch(/^When a contact status changes/)
  })

  it('extracts realtime tables and cross-cutting asks', () => {
    expect(ledger.realtime).toEqual(['contacts', 'followups'])
    expect(ledger.seedsRequested).toBe(true)
    expect(ledger.analyticsRequested).toBe(true)
    expect(ledger.authRequested).toBe(true)
    expect(ledger.storageRequested).toBe(true)
  })
})

// ── ledger.ts: reconciliation ────────────────────────────────────────────────

function fullPlanSteps(): BlueprintStep[] {
  return [
    { label: 'auth', tool: 'enable_auth', args: {} },
    {
      label: 'contacts', tool: 'create_table',
      args: { tableName: 'contacts', columns: [{ name: 'user_id' }, { name: 'name' }, { name: 'status' }, { name: 'next_followup_at' }] },
    },
    {
      label: 'followups', tool: 'create_table',
      args: { tableName: 'followups', columns: [{ name: 'user_id' }, { name: 'contact_id' }, { name: 'title' }, { name: 'due_date' }, { name: 'status' }] },
    },
    { label: 'rt1', tool: 'enable_realtime', args: { tableName: 'contacts' } },
    { label: 'rt2', tool: 'enable_realtime', args: { tableName: 'followups' } },
    {
      label: 'fn', tool: 'generate_function',
      args: { name: 'followup_after_send', trigger: 'on_update', table: 'contacts', description: 'When contact status changes to email_sent insert a followups row due in 5 days' },
    },
    {
      label: 'fn2', tool: 'generate_function',
      args: { name: 'log_status_history', trigger: 'on_update', table: 'contacts', description: 'insert a row into status_history whenever status changes' },
    },
    { label: 'bucket', tool: 'create_bucket', args: { bucketName: 'documents', isPublic: false } },
    { label: 'stats', tool: 'generate_aggregate_api', args: { name: 'summary' } },
    { label: 'seed', tool: 'seed_rows', args: { tableName: 'contacts', rows: [{ name: 'A' }, { name: 'B' }] } },
  ]
}

describe('reconcileLedger + renderLedgerReport', () => {
  const ledger = extractRequirements(OUTREACH_PROMPT)

  it('reports full coverage when the plan covers everything', () => {
    const report = reconcileLedger(ledger, appliedStateFromSteps(fullPlanSteps()))
    expect(report.missing).toBe(0)
    expect(report.partial).toBe(0)
    const rendered = renderLedgerReport(report, 'result')
    expect(rendered).toContain('Every requested item is built')
  })

  it('flags missing tables, automations, realtime, and seeds honestly', () => {
    const gutted = fullPlanSteps().filter(s =>
      s.tool !== 'seed_rows' &&
      s.tool !== 'generate_function' &&
      !(s.tool === 'enable_realtime' && (s.args as { tableName?: string }).tableName === 'followups') &&
      !(s.tool === 'create_table' && (s.args as { tableName?: string }).tableName === 'followups'),
    )
    const report = reconcileLedger(ledger, appliedStateFromSteps(gutted))
    expect(report.missing).toBeGreaterThanOrEqual(4) // followups table, 2 automations… realtime, seeds
    const rendered = renderLedgerReport(report, 'plan')
    expect(rendered).toContain('❌ table followups')
    expect(rendered).toContain('demo / seed data')
    expect(rendered).toContain('automation:')
  })

  it('reports partial when a requested column is missing from the created table', () => {
    const steps = fullPlanSteps().map(s =>
      s.tool === 'create_table' && (s.args as { tableName?: string }).tableName === 'contacts'
        ? { ...s, args: { tableName: 'contacts', columns: [{ name: 'user_id' }, { name: 'name' }] } }
        : s,
    )
    const report = reconcileLedger(ledger, appliedStateFromSteps(steps))
    const contactLine = report.lines.find(l => l.requirement === 'table contacts')
    expect(contactLine?.status).toBe('partial')
    expect(contactLine?.note).toContain('status')
    expect(contactLine?.note).toContain('next_followup_at')
  })

  it('treats a requested users table as satisfied by end-user auth', () => {
    const withUsers = extractRequirements('Create these tables:\n\n1. users\n- name\n- email\n- role\n')
    const report = reconcileLedger(withUsers, appliedStateFromSteps([{ label: 'auth', tool: 'enable_auth', args: {} }]))
    const usersLine = report.lines.find(l => l.requirement === 'table users')
    expect(usersLine?.status).toBe('built')
    expect(usersLine?.note).toContain('auth')
  })
})
