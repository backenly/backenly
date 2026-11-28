/**
 * The last line of a database export, written only after pg_dump has finished.
 *
 * A large export begins downloading while pg_dump is still running
 * (lib/services/database-export.ts). If pg_dump then fails, the connection is
 * cut, which every HTTP client reports as a failed download. This line is the
 * second check, for whoever holds the file afterwards: a file that does not end
 * with it is not a whole export, whatever delivered it.
 *
 * No imports: the console reads this in the browser, where the module that
 * runs pg_dump must never be bundled.
 */
export const EXPORT_COMPLETE_LINE = '-- Backenly database export complete'

/** How much of the end of a file is enough to find the line in. */
export const EXPORT_COMPLETE_TAIL_BYTES = 256

/** Whether the end of an export says pg_dump finished. `tail` is the file's last bytes as text. */
export function endsWithCompleteExport(tail: string): boolean {
  return tail.trimEnd().endsWith(EXPORT_COMPLETE_LINE)
}
