/**
 * What the brain's agent loop counts as a change.
 *
 * A call the loop counts as a mutation is listed in the turn's `applied`, which
 * an agent reads as "this changed", and sends a later finish back for a
 * verification pass. The count is allowlist-driven, a mutation unless it is a
 * read, so a read nobody listed is reported as a change that never happened and
 * verified for nothing. list_synced_columns and dry-run data migrations were
 * (#229). tests/integration/brain-mutation-accounting.spec.ts runs both through
 * a real turn.
 */

import { BRAIN_TOOLS } from '@/lib/ai/brain/tools'
import { isMutationCall } from '@/lib/ai/brain/agent'

/** Every tool in the catalog the loop counts as a mutation, called with no arguments. */
const MUTATIONS = BRAIN_TOOLS.map((t) => t.function.name).filter((name) => isMutationCall(name, {}))

/**
 * Tools named like a read that change something all the same, each with the
 * reason. This list is the only way past the naming rule below, so an entry
 * without a reason is the bug coming back.
 */
const CHANGES_UNDER_A_READ_NAME: Record<string, string> = {
  get_database_credentials: 'provisions a Postgres role and its password the first time a mode is asked for',
}

describe('what the loop counts as a change', () => {
  it('counts no list_* or get_* tool as a change unless the allowlist says why', () => {
    const named = MUTATIONS.filter((name) => /^(list|get)_/.test(name) && !(name in CHANGES_UNDER_A_READ_NAME))
    expect(named).toEqual([])
  })

  it('allows only tools that are still counted as a change', () => {
    // An entry for a tool that has since become a read would excuse the next one.
    expect(Object.keys(CHANGES_UNDER_A_READ_NAME).filter((name) => !MUTATIONS.includes(name))).toEqual([])
  })

  it('still counts the writes, and never the control tools', () => {
    // Guards the rules above: over an empty list they would pass checking nothing.
    expect(MUTATIONS).toEqual(expect.arrayContaining(['create_table', 'set_rls', 'run_data_migration', 'drop_table']))
    for (const control of ['finish', 'ask_user', 'answer_question', 'propose_plan']) {
      expect(MUTATIONS).not.toContain(control)
    }
  })

  it('counts re-checking an integration key as a change', () => {
    // It writes the provider's answer onto the stored key, which
    // list_integration_keys and the dashboard then report, and the MCP door
    // refuses it to a read-only key for that reason.
    expect(MUTATIONS).toContain('verify_integration_key')
  })
})

describe('a call its arguments decide', () => {
  const operations = [{ op: 'backfill', table: 'accounts', column: 'status', value: 'active' }]

  it('counts a dry-run data migration as a read', () => {
    expect(isMutationCall('run_data_migration', { operations, dryRun: true })).toBe(false)
  })

  it('counts a data migration that is not a dry run as a change', () => {
    expect(isMutationCall('run_data_migration', { operations, dryRun: false })).toBe(true)
    expect(isMutationCall('run_data_migration', { operations })).toBe(true)
  })
})
