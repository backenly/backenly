/**
 * Every next step names something that exists (production QA, 2026-11-09).
 *
 * The console's AI chat was removed on 2026-07-17: agents (Claude Code, Cursor,
 * Codex) are the client now. The next steps findings give still said "in the
 * AI chat, say …", so a hot table, a table with no archival job, expired
 * tokens, a policy reading the old identity and any finding without a repair
 * all ended in a step nobody could take. QA read them as findings "with no next
 * step".
 */
import { ALL_FINDING_TYPES } from '@/lib/core/types'
import { getManualRemediationHint } from '@/lib/core/fix-actions'
import { groupFindings } from '@/lib/core/finding-groups'
import { generateTypes } from '@/lib/typegen/type-generator'

const details = { tableName: 'orders', table: 'orders', idxHitPct: 4, seqScans: 1200, avgMs: 140 }

describe('next steps', () => {
  it('never send anyone to the AI chat, for any kind of finding', () => {
    for (const type of [...ALL_FINDING_TYPES, 'something_backenly_has_no_repair_for']) {
      const hint = getManualRemediationHint(type, details) ?? ''
      expect({ type, mentionsChat: /AI chat/i.test(hint) }).toEqual({ type, mentionsChat: false })
    }
    const [group] = groupFindings([{ id: 'f1', type: 'something_backenly_has_no_repair_for', severity: 'warning', details: {} } as any])
    expect(JSON.stringify(group)).not.toMatch(/AI chat/i)
  })

  it('give a hot table a step to take: the coding agent, and the statement', () => {
    expect(getManualRemediationHint('infra_hot_table', details)).toBe(
      '"orders" is taking heavy sequential scans and Backenly could not find a column it is safe to index ' +
        'automatically. It was read 1,200× with 4% index coverage. Add an index on the column your queries on ' +
        '"orders" filter or sort by: ask your coding agent to add it with apply_migration (CREATE INDEX ON orders (<column>)).',
    )
  })

  it('name the table a cleanup job is for', () => {
    expect(getManualRemediationHint('missing_archival_job', { tableName: 'events' })).toBe(
      "events will keep growing without bound. If its old rows can go after a while, ask your coding agent to " +
        "deploy a scheduled function that deletes events's rows older than the retention you choose (90 days, say).",
    )
    expect(getManualRemediationHint('missing_token_cleanup_cron', { tableName: 'password_resets' })).toBe(
      'Expired tokens are accumulating in password_resets. Ask your coding agent to deploy a scheduled function ' +
        'that deletes the expired rows from password_resets once a day.',
    )
  })

  it('point a finding without a repair at the dashboard or the coding agent', () => {
    expect(getManualRemediationHint('something_backenly_has_no_repair_for', {})).toBe(
      'Backenly flagged this but has no automatic repair for it yet. Open the relevant section of your dashboard, ' +
        'or ask your coding agent to look into it.',
    )
  })

  it('in the generated types of an empty project, too', () => {
    const { source } = generateTypes({ projectId: 'p1', tables: [] } as any)
    expect(source).toContain('// Ask your coding agent to create tables, then generate the types again.')
    expect(source).not.toMatch(/AI chat/i)
  })
})
