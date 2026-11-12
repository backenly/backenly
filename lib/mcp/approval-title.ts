/**
 * A parked call's card title: what approving it does, as a sentence that starts
 * with its verb, built from Backenly's description of the call
 * (lib/mcp/approval-describe.ts). Cards used to read "Run revoke_api_key on
 * Connect: revoke_api_key (keyId=ec1b…)", the tool's name and its arguments.
 *
 * No server imports: the Review Queue builds the title in the browser.
 */

const VERBS: Record<string, string> = {
  drop_table: 'Drop',
  truncate_table: 'Delete',
  drop_column: 'Drop',
  delete_bucket: 'Delete',
  delete_file: 'Delete',
  disable_realtime: 'Turn off',
  revoke_api_key: 'Revoke',
  rotate_api_key: 'Rotate',
  delete_env_var: 'Delete',
  delete_trigger: 'Delete',
  delete_ai_function: 'Delete',
  delete_cron_job: 'Delete',
  remove_integration_key: 'Disconnect',
  delete_webhook: 'Delete',
  discard_branch: 'Discard',
  block_end_user: 'Block',
  remove_permission: 'Remove',
  disable_oauth_provider: 'Turn off',
  remove_auth_smtp: 'Remove',
  run_data_migration: 'Rewrite',
  trigger_deploy: 'Publish',
}

/** Calls whose description is already the whole sentence. */
const SENTENCES = new Set(['apply_migration', 'revert_schema_change', 'rollback_deploy'])

export function approvalTitle(tool: string, target: string): string {
  const text = target.trim()
  if (SENTENCES.has(tool)) return text.charAt(0).toUpperCase() + text.slice(1)
  // "merge of preview branch `x` into production (…)" reads as a noun; say it.
  if (tool === 'merge_branch') return text.replace(/^merge of /i, 'Merge ').replace(/^merge /, 'Merge ')
  const verb = VERBS[tool]
  return verb ? `${verb} ${text}` : `Run ${tool} on ${text}`
}
