/**
 * A parked call's card title says what approving it does, from Backenly's
 * description of the call (lib/mcp/approval-title.ts), not the tool's name and
 * its arguments: cards read "Run revoke_api_key on Connect: revoke_api_key
 * (keyId=…)" (production QA, 2026-11-09).
 */
import { approvalTitle } from '@/lib/mcp/approval-title'

it('starts with the verb of what approving does', () => {
  expect(approvalTitle('revoke_api_key', 'the API key “Storefront” (proj_live_3fa2…, a browser key, last used 2 hours ago): every client using it stops working immediately'))
    .toBe('Revoke the API key “Storefront” (proj_live_3fa2…, a browser key, last used 2 hours ago): every client using it stops working immediately')
  expect(approvalTitle('delete_ai_function', 'the function `qa-diag`')).toBe('Delete the function `qa-diag`')
  expect(approvalTitle('discard_branch', 'the preview branch `shop-fixes` and every unmerged change on it'))
    .toBe('Discard the preview branch `shop-fixes` and every unmerged change on it')
  expect(approvalTitle('drop_column', 'column `label` on `notes`')).toBe('Drop column `label` on `notes`')
  expect(approvalTitle('truncate_table', 'all rows in `notes`')).toBe('Delete all rows in `notes`')
  expect(approvalTitle('disable_realtime', 'realtime on `notes` (live subscribers disconnect)')).toBe('Turn off realtime on `notes` (live subscribers disconnect)')
  expect(approvalTitle('trigger_deploy', 'the backend as it is now, as a new published version')).toBe('Publish the backend as it is now, as a new published version')
})

it('reads a merge and a held migration as the sentences they are', () => {
  expect(approvalTitle('merge_branch', 'merge of preview branch `shop` into production (3 statements reach production)'))
    .toBe('Merge preview branch `shop` into production (3 statements reach production)')
  expect(approvalTitle('merge_branch', 'Merge preview branch "shop" into production')).toBe('Merge preview branch "shop" into production')
  expect(approvalTitle('apply_migration', 'Apply a migration to production')).toBe('Apply a migration to production')
})

it('names the tool only for a call it has no verb for', () => {
  expect(approvalTitle('something_new', '`something_new`')).toBe('Run something_new on `something_new`')
})
