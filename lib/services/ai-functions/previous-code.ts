/**
 * What an answer says about a function's replaced code.
 *
 * A redeploy is a governed change, and the change history keeps the code it
 * replaced (lib/changes/resources/functions.ts): restoring that change brings
 * it back. Both doors that replace code said the opposite ("the previous code
 * is not kept, so there is nothing to roll back to"), which production QA
 * (2026-11-09) read against llms.txt's promise that every change to functions
 * is one History entry you can restore.
 */

/**
 * Where a replaced function's code went. The change history keeps it: restoring
 * the change that replaced it brings it back, from History or, for an agent,
 * by asking with revert_change (a person approves it).
 */
export function previousCodeNote(sameCode: boolean, change: { id: string; seq: number } | null): string {
  if (sameCode) return '. Its code was already this, so the code did not change'
  if (!change) return ''
  return (
    `. The previous code is kept in the change history as change #${change.seq}: ` +
    `restore that change in History to bring it back, or ask with deploy { action: "revert_change", changeId: "${change.id}" } (a person approves it)`
  )
}
