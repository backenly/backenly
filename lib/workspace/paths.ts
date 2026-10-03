/**
 * Where generated project workspaces live on disk.
 *
 * One resolver, used by every reader and writer. Before this existed, roughly
 * twenty call sites each independently computed
 * `path.join(process.cwd(), 'workspace', projectId)`, and only the purge path
 * honoured `WORKSPACE_DIR`. Its own comment recorded the hazard that created:
 *
 *   "setting it in a real deployment without also changing those writers would
 *    point cleanup at a directory nothing writes to"
 *
 * That is a deletion aimed at the wrong tree, so the override was effectively
 * unusable and the location was pinned to the current working directory.
 *
 * `process.cwd()` is a poor anchor here in any case. The Next standalone server
 * calls `process.chdir(__dirname)` on startup, so the same code resolves a
 * DIFFERENT directory depending on whether it runs under `next dev`, under the
 * standalone bundle, or under the tsx runtime — which is precisely how the
 * workspace backups ended up stranded in `.next/standalone/backups`.
 *
 * Containers need this to point at a mounted volume:
 *
 *   WORKSPACE_DIR=/app/workspace   (EFS)
 *
 * Resolved per call rather than captured at module load, so a test can redirect
 * the root and so a late `chdir` cannot freeze a stale value.
 */
import * as path from 'path'

/**
 * The root directory holding every project workspace.
 *
 * With `WORKSPACE_DIR` set, that path wins and is resolved to an absolute one.
 * Unset, the historical `process.cwd()/workspace` is preserved exactly, so an
 * existing deployment that configures nothing keeps the layout it already has.
 */
export function workspaceRoot(): string {
  const configured = process.env.WORKSPACE_DIR?.trim()
  if (configured) return path.resolve(configured)
  return path.join(process.cwd(), 'workspace')
}

/** The directory for one project's generated workspace. */
export function projectWorkspaceDir(projectId: string): string {
  return path.join(workspaceRoot(), projectId)
}
