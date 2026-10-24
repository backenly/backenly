/**
 * Every call the brain's approval gate stops is held, not run, and described to
 * the person who approves it (#246).
 *
 * The gate and the description of what a call would do are one path
 * (needsApproval, then describeDanger) with a branch for each kind of call. A
 * wrong target here is a person approving something other than what they read,
 * so each branch is run through the real loop: the model issues the call, the
 * turn returns it as issued in blockedCalls, and the card names what it would
 * touch, with live row counts and the real trigger or webhook it resolves.
 *
 * Real database: the table whose rows are counted, and the trigger and webhook
 * rows the cards resolve. Only the model is scripted.
 */

import { prisma } from '@/lib/db/prisma'
import { ledgerEnabled } from '@/lib/changes/ledger'
import { needsApproval } from '@/lib/mcp/domains'
import { BRAIN_MODEL_TOOLS } from '@/lib/ai/brain/tools'
import { classified, finished, toolCall, setUpBrainProject } from '../helpers/brain-harness'

const brain = setUpBrainProject({ name: 'brain-approval-targets', tables: ['keep_me'] })

let triggerId: string
let webhookId: string

beforeAll(async () => {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${brain.schema}"."keep_me" (label) VALUES ('a'), ('b'), ('c')`,
  )
  triggerId = (await prisma.appTrigger.create({
    data: {
      projectId: brain.projectId,
      name: 'notify-on-like',
      sourceTable: 'keep_me',
      event: 'insert',
      actionType: 'webhook',
      webhookUrl: 'https://example.test/hook',
    },
  })).id
  webhookId = (await prisma.webhook.create({
    data: {
      projectId: brain.projectId,
      eventType: 'row.inserted',
      targetUrl: 'https://example.test/receiver',
      secret: 'not-a-real-secret',
    },
  })).id
}, 60_000)

// The harness rebuilds the workspace before each test; the rows are put back.
beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${brain.schema}"."keep_me" (label) VALUES ('a'), ('b'), ('c')`,
  )
})

/** Issue one call on a DESTRUCTIVE turn, and return what the turn held. */
async function hold(tool: string, args: Record<string, unknown>) {
  const turn = await brain.turn(
    [classified('DESTRUCTIVE'), toolCall(tool, args, 'toolu_gated'), finished('Queued for approval.')],
    `please run ${tool}`,
  )
  return { ...turn, held: turn.result.blockedCalls ?? [] }
}

interface Row {
  tool: string
  args: () => Record<string, unknown>
  target: string | RegExp
  rowCount?: number | null
  reversible?: boolean | (() => boolean)
}

const ROWS: Row[] = [
  { tool: 'drop_table', args: () => ({ tableName: 'keep_me' }), target: 'the `keep_me` table', rowCount: 3, reversible: () => ledgerEnabled(brain.projectId) },
  { tool: 'drop_table', args: () => ({}), target: 'the `unknown` table', rowCount: null },
  { tool: 'drop_table', args: () => ({ tableName: 'no_such_table' }), target: 'the `no_such_table` table' },
  { tool: 'truncate_table', args: () => ({ tableName: 'keep_me' }), target: 'all rows in `keep_me`', rowCount: 3, reversible: false },
  { tool: 'drop_column', args: () => ({ tableName: 'keep_me', columnName: 'label' }), target: 'column `label` on `keep_me`', rowCount: 3, reversible: () => ledgerEnabled(brain.projectId) },
  { tool: 'revert_schema_change', args: () => ({ changeId: 'no-such-change' }), target: 'the state before a change', reversible: true },
  { tool: 'delete_bucket', args: () => ({ bucketName: 'media' }), target: 'the `media` bucket and every file in it', reversible: false },
  { tool: 'delete_file', args: () => ({ fileName: 'avatar.png' }), target: 'the file `avatar.png`', reversible: false },
  { tool: 'disable_realtime', args: () => ({ tableName: 'keep_me' }), target: 'realtime on `keep_me`', reversible: true },
  { tool: 'disable_realtime', args: () => ({}), target: /realtime project-wide|realtime on EVERY streaming table/, reversible: true },
  { tool: 'trigger_deploy', args: () => ({}), target: 'a production deploy', reversible: true },
  { tool: 'rollback_deploy', args: () => ({}), target: 'the backend as it was at an earlier published version', reversible: true },
  { tool: 'revoke_api_key', args: () => ({ keyId: 'k1' }), target: 'an API key (every client using it stops working immediately)', reversible: false },
  { tool: 'rotate_api_key', args: () => ({ keyId: 'k1' }), target: 'an API key rotation (the old key stops working immediately)', reversible: false },
  { tool: 'delete_env_var', args: () => ({ name: 'STRIPE_KEY' }), target: 'the env var `STRIPE_KEY` (functions reading it will fail)', reversible: false },
  { tool: 'delete_trigger', args: () => ({ triggerId }), target: 'the trigger `notify-on-like`', reversible: false },
  { tool: 'delete_trigger', args: () => ({ triggerId: 'ghost-trigger' }), target: '`ghost-trigger` (no such trigger in this project)', reversible: false },
  { tool: 'delete_trigger', args: () => ({ name: 'by-name' }), target: 'the trigger `by-name`', reversible: false },
  { tool: 'delete_trigger', args: () => ({}), target: 'no trigger (the call names none)', reversible: false },
  { tool: 'delete_ai_function', args: () => ({ name: 'summarise' }), target: 'the function `summarise`', reversible: false },
  { tool: 'delete_cron_job', args: () => ({ name: 'nightly' }), target: 'the scheduled job `nightly`', reversible: false },
  { tool: 'remove_integration_key', args: () => ({ provider: 'stripe' }), target: 'the stripe integration (functions calling it will fail)', reversible: false },
  { tool: 'delete_webhook', args: () => ({ webhookId }), target: /row\.inserted → https:\/\/example\.test\/receiver\) and its delivery history/, reversible: false },
  { tool: 'delete_webhook', args: () => ({ webhookId: 'ghost-webhook' }), target: '(no such webhook in this project)', reversible: false },
  { tool: 'delete_webhook', args: () => ({}), target: 'no webhook (the call names none)', reversible: false },
  { tool: 'merge_branch', args: () => ({ branchId: 'ghost-branch' }), target: 'merge of preview branch `ghost-branch` into production', reversible: false },
  { tool: 'merge_branch', args: () => ({}), target: 'merge of preview branch `unknown` into production', reversible: false },
  { tool: 'discard_branch', args: () => ({ branchId: 'ghost-branch' }), target: 'the preview branch `ghost-branch` and every unmerged change on it', reversible: false },
  { tool: 'block_end_user', args: () => ({ email: 'a@example.test' }), target: 'the end-user a@example.test (they lose access immediately)', reversible: true },
  { tool: 'remove_permission', args: () => ({}), target: 'a row-level security policy (data exposure may widen)', reversible: true },
  { tool: 'disable_oauth_provider', args: () => ({ provider: 'google' }), target: 'google sign-in (end-users on this provider cannot log in)', reversible: true },
  { tool: 'remove_auth_smtp', args: () => ({}), target: /this project's SMTP settings/, reversible: false },
]

describe('a call the approval gate stops is held as issued and described to the approver', () => {
  it.each(ROWS.map((r, i) => [`${r.tool} #${i}`, r] as const))('%s', async (_name, row) => {
    const args = row.args()
    const { held, result, provider, events } = await hold(row.tool, args)

    // Held as the model issued it, once, and nothing ran.
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ tool: row.tool, args })
    if (typeof row.target === 'string') expect(held[0].target).toContain(row.target)
    else expect(held[0].target).toMatch(row.target)
    if (row.rowCount !== undefined) expect(held[0].rowCount).toBe(row.rowCount)
    if (row.reversible !== undefined) {
      expect(held[0].reversible).toBe(typeof row.reversible === 'function' ? row.reversible() : row.reversible)
    }
    expect(result.toolsRun).toEqual(['finish'])
    expect(result.applied).toEqual([])
    expect(await brain.tableExists('keep_me')).toBe(true)

    // The approver's card is announced, and the model is told it waits, not that it failed.
    expect(events).toContainEqual(expect.objectContaining({ type: 'danger', tool: row.tool }))
    const answer = JSON.stringify(provider.calls[2].params.messages.at(-1))
    expect(answer).toContain('needs_human_approval')
    expect(answer).toContain('NOT run')
  }, 60_000)
})

describe('every tool the brain\'s model is offered that needs approval', () => {
  const gated = BRAIN_MODEL_TOOLS.map((t) => t.function.name).filter((name) => needsApproval(name))

  it('is a real set, so the table above cannot silently cover nothing', () => {
    expect(gated.length).toBeGreaterThanOrEqual(23)
  })

  it.each(gated)('%s is held with a target, never run', async (tool) => {
    const { held, result } = await hold(tool, {})

    expect(held).toHaveLength(1)
    expect(held[0].tool).toBe(tool)
    expect(held[0].target.length).toBeGreaterThan(0)
    expect(result.toolsRun).toEqual(['finish'])
    expect(result.applied).toEqual([])
  }, 60_000)
})

describe('a call the model repeats', () => {
  it('is returned once however often it is issued, and a different call is returned too', async () => {
    const { result } = await brain.turn(
      [
        classified('DESTRUCTIVE'),
        toolCall('drop_table', { tableName: 'keep_me' }, 'toolu_first'),
        toolCall('drop_table', { tableName: 'keep_me' }, 'toolu_again'),
        toolCall('truncate_table', { tableName: 'keep_me' }, 'toolu_other'),
        finished('Queued.'),
      ],
      'drop keep_me',
    )

    expect(result.blockedCalls?.map((b) => b.tool)).toEqual(['drop_table', 'truncate_table'])
  }, 60_000)

  it('is held when it comes in one step with a read that does run', async () => {
    const { result } = await brain.turn(
      [
        classified('DESTRUCTIVE'),
        {
          ...toolCall('read_backend_state', {}, 'toolu_read'),
          content: [
            { type: 'tool_use', id: 'toolu_read', name: 'read_backend_state', input: {} },
            { type: 'tool_use', id: 'toolu_drop', name: 'drop_table', input: { tableName: 'keep_me' } },
          ],
        } as never,
        finished('Queued.'),
      ],
      'drop keep_me',
    )

    expect(result.toolsRun).toEqual(['read_backend_state', 'finish'])
    expect(result.blockedCalls).toHaveLength(1)
    expect(await brain.tableExists('keep_me')).toBe(true)
  }, 60_000)
})
