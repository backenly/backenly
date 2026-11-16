/**
 * Whether History can bring something back, said the same way in every
 * destructive confirm (project decision 8, 2026-11-16). KitConfirmDialog's
 * `undoable` prop renders it; this is the sentence on its own, for a confirm
 * that is not a KitConfirmDialog (an inline "Delete this row?").
 *
 *   true                                 You can undo this in History.
 *   { detail: 'code and all' }           You can undo this in History, code and all.
 *   { days: 7, detail: 'rows included' } You can undo it from History for 7 days, rows included.
 *   false                                You can't undo this.
 *
 * "Undo" is one change; "Restore to …" is a point or a version (Snapshots keep
 * "Restore"); "Reapply" stays. A false is followed by what is lost, in the
 * caller's words ("Its 240 files are deleted for good.").
 */

export type Undoable = boolean | { days?: number | null; detail?: string | null }

export function undoSentence(undoable: Undoable): string {
  if (undoable === false) return "You can't undo this."
  if (undoable === true) return 'You can undo this in History.'
  const detail = undoable.detail ? `, ${undoable.detail}` : ''
  if (typeof undoable.days === 'number' && undoable.days > 0) {
    return `You can undo it from History for ${undoable.days} ${undoable.days === 1 ? 'day' : 'days'}${detail}.`
  }
  return `You can undo this in History${detail}.`
}
