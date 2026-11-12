/**
 * WHAT A CALL WAITING FOR A PERSON WOULD DO, IN WORDS
 * ===================================================
 * One description per parked call, whichever door parked it: the brain's
 * approval gate (lib/ai/brain/agent.ts) and the MCP tool route's typed calls
 * (app/api/mcp/tool/route.ts). The typed door used to describe a call by its
 * tool and arguments ("Connect: revoke_api_key (keyId=ec1b…)"), so a person
 * approving a key revocation could not tell a throwaway key from the one the
 * live frontend uses. The card's title is built from this description
 * (lib/mcp/approval-title.ts).
 */

/**
 * Describe a call the approval gate stopped, for the Review Queue request the
 * caller files from it (BlockedCall). Best-effort row count via the
 * workspace-table-stats kernel (cached COUNT — cheap).
 * Honesty rules baked in:
 *   • A dropped table or column is reversible because its data is not
 *     destroyed: inside a recorded change it moves into the change's vault and
 *     rolling the change back restores it (lib/changes/preserve.ts). Only while
 *     the ledger is on; without it the old answer, irreversible, is the true one.
 *   • Truncation deletes rows, which are data rather than schema, and nothing
 *     keeps them, so it stays irreversible.
 */
export async function describeApproval(
  projectId: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ tool: string; target: string; rowCount: number | null; reversible: boolean; confirmPhrase: string }> {
  const str = (k: string): string | null => {
    const v = args[k]
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }
  const tableName = str('tableName') ?? str('table')
  const columnName = str('columnName') ?? str('column')
  const namedThing =
    str('bucketName') ?? str('fileName') ?? str('path') ?? str('name') ??
    str('provider') ?? str('email') ?? str('keyId') ?? str('id')

  // Live row count for table-shaped destruction — cached COUNT, never blocks long.
  let rowCount: number | null = null
  if (tableName && (tool === 'drop_table' || tool === 'truncate_table' || tool === 'drop_column')) {
    try {
      const { getTableStat } = await import('@/lib/services/workspace-table-stats')
      const stat = await getTableStat(projectId, tableName)
      rowCount = stat.rows
    } catch { rowCount = null }
  }

  const { ledgerEnabled } = await import('@/lib/changes/ledger')
  const kept = ledgerEnabled(projectId)

  switch (tool) {
    case 'drop_table':
      return {
        tool,
        target: `the \`${tableName ?? 'unknown'}\` table`,
        rowCount,
        reversible: kept, // its rows move into the change's vault
        confirmPhrase: `Confirm — drop the ${tableName ?? ''} table`.trim(),
      }
    case 'truncate_table':
      return {
        tool,
        target: `all rows in \`${tableName ?? 'unknown'}\``,
        rowCount,
        reversible: false,
        confirmPhrase: `Confirm — delete all rows in ${tableName ?? 'the table'}`,
      }
    case 'drop_column':
      return {
        tool,
        target: `column \`${columnName ?? 'unknown'}\` on \`${tableName ?? 'unknown'}\``,
        rowCount,
        reversible: kept, // its values are copied into the change's vault first
        confirmPhrase: `Confirm — drop the ${columnName ?? ''} column`.trim(),
      }
    case 'revert_schema_change': {
      const change = await import('@/lib/db/prisma')
        .then(({ prisma }) => prisma.backendChange.findFirst({
          where: { id: String(args.changeId ?? ''), projectId },
          select: { seq: true, summary: true, title: true },
        }))
        .catch(() => null)
      return {
        tool,
        target: change ? `the state before change #${change.seq} (${change.summary ?? change.title})` : 'the state before a change',
        rowCount: null,
        // A restore keeps what it removes and is itself recorded: it can be reapplied.
        reversible: true,
        confirmPhrase: `Confirm — restore the state before change #${change?.seq ?? ''}`.trim(),
      }
    }
    case 'delete_bucket':
      return { tool, target: `the \`${namedThing ?? 'unknown'}\` bucket and every file in it`, rowCount: null, reversible: false, confirmPhrase: `Confirm — delete the ${namedThing ?? ''} bucket`.trim() }
    case 'delete_file':
      return { tool, target: `the file \`${namedThing ?? 'unknown'}\``, rowCount: null, reversible: false, confirmPhrase: 'Confirm — delete the file' }
    case 'disable_realtime': {
      if (tableName) {
        return { tool, target: `realtime on \`${tableName}\` (live subscribers disconnect)`, rowCount: null, reversible: true, confirmPhrase: 'Confirm — disable realtime' }
      }
      // Project-wide: the card must name the blast radius, not a bare word.
      let scope = 'realtime on every streaming table (live subscribers disconnect)'
      try {
        const { listTablesWithRealtimeTriggers } = await import('@/lib/services/realtimeTriggers')
        const streaming = await listTablesWithRealtimeTriggers(projectId)
        scope = streaming.length === 0
          ? 'realtime project-wide — no table is currently streaming, so nothing disconnects'
          : `realtime on EVERY streaming table (${streaming.length}: ${streaming.join(', ')}) — their live subscribers disconnect`
      } catch { /* keep the generic scope */ }
      return { tool, target: scope, rowCount: null, reversible: true, confirmPhrase: 'Confirm — disable realtime on every table' }
    }
    case 'trigger_deploy':
      return { tool, target: 'the backend as it is now, as a new published version', rowCount: null, reversible: true, confirmPhrase: 'Confirm — deploy to production' }
    case 'rollback_deploy': {
      const version = Number.isInteger(args.version) ? String(args.version) : str('version')
      return {
        tool,
        target: version ? `the backend as it was when v${version} was published (every change since undone)` : 'the backend as it was at an earlier published version',
        rowCount: null,
        // Each step is a restore, which keeps what it removes and can be reapplied.
        reversible: true,
        confirmPhrase: `Confirm — restore the backend to ${version ? `v${version}` : 'that version'}`,
      }
    }
    case 'revoke_api_key':
    case 'rotate_api_key': {
      // The key by its name and what it is for, so a person can tell the key a
      // live frontend uses from a throwaway one an agent made. The call names
      // it by id alone.
      const key = await describeKey(projectId, str('keyId') ?? str('id'))
      const effect = tool === 'revoke_api_key'
        ? 'every client using it stops working immediately'
        : 'the old key stops working immediately; the new one is shown once, to whoever approves'
      return {
        tool,
        target: `${key}: ${effect}`,
        rowCount: null,
        reversible: false,
        confirmPhrase: tool === 'revoke_api_key' ? 'Confirm — revoke the API key' : 'Confirm — rotate the API key',
      }
    }
    case 'delete_env_var':
      return { tool, target: `the env var \`${namedThing ?? 'unknown'}\` (functions reading it will fail)`, rowCount: null, reversible: false, confirmPhrase: `Confirm — delete the ${namedThing ?? ''} env var`.trim() }
    case 'delete_trigger': {
      // The card names the trigger the person is approving. A call by id alone
      // read as `unknown`, so the deletion was approved unseen (WH-F15).
      const triggerId = str('triggerId')
      let label = triggerId ? `\`${triggerId}\`` : namedThing ? `\`${namedThing}\`` : null
      if (triggerId) {
        try {
          const { prisma } = await import('@/lib/db')
          const found = await prisma.appTrigger.findFirst({ where: { id: triggerId, projectId }, select: { name: true } })
          label = found ? `\`${found.name}\`` : `\`${triggerId}\` (no such trigger in this project)`
        } catch { /* keep the id */ }
      }
      return {
        tool,
        target: label ? `the trigger ${label}` : 'no trigger (the call names none)',
        rowCount: null,
        reversible: false,
        confirmPhrase: 'Confirm — delete the trigger',
      }
    }
    case 'delete_ai_function':
      return { tool, target: `the function \`${namedThing ?? 'unknown'}\``, rowCount: null, reversible: false, confirmPhrase: 'Confirm — delete the function' }
    case 'delete_cron_job':
      return { tool, target: `the scheduled job \`${namedThing ?? 'unknown'}\``, rowCount: null, reversible: false, confirmPhrase: 'Confirm — delete the scheduled job' }
    case 'remove_integration_key':
      return { tool, target: `the ${namedThing ?? ''} integration (functions calling it will fail)`.trim(), rowCount: null, reversible: false, confirmPhrase: 'Confirm — disconnect the integration' }
    case 'delete_webhook': {
      // The card names the endpoint the person is approving. The call carries
      // only an id, and a bare `delete_webhook` did not say which receiver
      // stops getting events.
      const webhookId = str('webhookId')
      let target = webhookId ? `the webhook \`${webhookId}\` and its delivery history` : 'no webhook (the call names none)'
      if (webhookId) {
        try {
          const { prisma } = await import('@/lib/db')
          const found = await prisma.webhook.findFirst({ where: { id: webhookId, projectId }, select: { eventType: true, targetUrl: true } })
          target = found
            ? `the webhook \`${webhookId}\` (${found.eventType} → ${found.targetUrl}) and its delivery history`
            : `the webhook \`${webhookId}\` (no such webhook in this project)`
        } catch { /* keep the id */ }
      }
      return {
        tool,
        target,
        rowCount: null,
        // Its signing secret goes with it: an endpoint created again signs with
        // a new one, which the receiver does not have.
        reversible: false,
        confirmPhrase: 'Confirm — delete the webhook',
      }
    }
    case 'block_end_user':
      return { tool, target: `the end-user ${namedThing ?? ''} (they lose access immediately)`.trim(), rowCount: null, reversible: true, confirmPhrase: 'Confirm — block the user' }
    case 'remove_permission':
      return { tool, target: 'a row-level security policy (data exposure may widen)', rowCount: null, reversible: true, confirmPhrase: 'Confirm — remove the permission' }
    case 'disable_oauth_provider':
      return { tool, target: `${namedThing ?? 'an OAuth'} sign-in (end-users on this provider cannot log in)`, rowCount: null, reversible: true, confirmPhrase: 'Confirm — disable the provider' }
    case 'remove_auth_smtp': {
      // The card says where auth email goes once the settings are gone: through
      // the deployment's SMTP when its environment has one, and otherwise
      // nowhere (resolveProjectSmtp, lib/email/project-smtp.ts).
      const { readEnvSmtpCredentials } = await import('@/lib/email/smtp-transport')
      const after = readEnvSmtpCredentials()
        ? "go out through the deployment's SMTP instead"
        : 'stop: this deployment has no SMTP to fall back to'
      return {
        tool,
        target: `this project's SMTP settings (verification, password-reset and magic-link emails then ${after})`,
        rowCount: null,
        // The stored password is deleted with them, so putting them back means
        // entering it again.
        reversible: false,
        confirmPhrase: 'Confirm — remove the SMTP settings',
      }
    }
    case 'merge_branch':
    case 'discard_branch': {
      // The approval card is the only thing the human reads before a branch
      // reaches (or loses) production — a bare `merge_branch` target made them
      // approve blind. Resolve the branch name and statement count; if the
      // lookup fails the generic shape below still names the id.
      const branchId = str('branchId') ?? str('branch')
      let branchName: string | null = null
      let statementCount: number | null = null
      if (branchId) {
        try {
          const { diffBranch } = await import('@/lib/branches/engine')
          const diff = await diffBranch(projectId, branchId)
          if (diff.ok) {
            branchName = diff.branch
            statementCount = diff.migrations.length
          }
        } catch { /* keep the id-based target */ }
      }
      const label = branchName ? `\`${branchName}\`` : `\`${branchId ?? 'unknown'}\``
      if (tool === 'merge_branch') {
        const count = statementCount === null ? '' : ` (${statementCount} statement${statementCount === 1 ? '' : 's'} reach production)`
        return { tool, target: `merge of preview branch ${label} into production${count}`, rowCount: null, reversible: false, confirmPhrase: `Confirm — merge ${branchName ?? branchId ?? 'the branch'} into production`.trim() }
      }
      return { tool, target: `the preview branch ${label} and every unmerged change on it`, rowCount: null, reversible: false, confirmPhrase: `Confirm — discard ${branchName ?? branchId ?? 'the branch'}`.trim() }
    }
    default:
      return { tool, target: `\`${tool}\``, rowCount: null, reversible: false, confirmPhrase: `Confirm — run ${tool}` }
  }
}

/**
 * "the API key “Storefront” (proj_live_3fa2…, a browser key, last used 2 hours
 * ago)": an API key of this project as a person knows it. A key that is not
 * the project's is said to be so, and its id kept.
 */
async function describeKey(projectId: string, keyId: string | null): Promise<string> {
  if (!keyId) return 'an API key (the call names none)'
  try {
    const { prisma } = await import('@/lib/db/prisma')
    const key = await prisma.apiKey.findFirst({
      where: { id: keyId, projectId },
      select: { name: true, keyPrefix: true, keyType: true, serviceRole: true, scope: true, lastUsed: true },
    })
    if (!key) return `the API key \`${keyId}\` (no such key in this project)`
    const kind =
      key.scope === 'mcp' ? 'an agent key'
      : key.serviceRole ? 'a server key'
      : key.keyType === 'public' ? 'a browser key'
      : 'a key'
    const used = key.lastUsed ? `last used ${ago(key.lastUsed)}` : 'never used'
    const prefix = key.keyPrefix ? `${key.keyPrefix}…, ` : ''
    return `the API key “${key.name}” (${prefix}${kind}, ${used})`
  } catch {
    return `the API key \`${keyId}\``
  }
}

/** "4 minutes ago", "2 hours ago", "3 days ago". */
function ago(when: Date, now: Date = new Date()): string {
  const s = Math.max(0, Math.round((now.getTime() - when.getTime()) / 1000))
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`
  if (s < 60) return 'just now'
  if (s < 3600) return unit(Math.floor(s / 60), 'minute')
  if (s < 86_400) return unit(Math.floor(s / 3600), 'hour')
  return unit(Math.floor(s / 86_400), 'day')
}
