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

/**
 * The absolute path `relative` names inside one project's workspace, or null
 * when it would land anywhere else.
 *
 * `relative` comes from a request, so it is checked, not trusted: a `..`
 * segment, an absolute path or a NUL byte would otherwise name a file outside
 * the project's workspace. Only the names are compared here. A caller that
 * opens the file also asks `realPathInsideWorkspace`, because a symbolic link
 * inside the workspace can point anywhere.
 */
export function resolveInsideWorkspace(projectId: string, relative: unknown): string | null {
  if (typeof relative !== 'string' || relative.length === 0 || relative.includes('\0')) return null
  const root = path.resolve(projectWorkspaceDir(projectId))
  const target = path.resolve(root, relative)
  return target.startsWith(root + path.sep) ? target : null
}

/**
 * Whether `target` is still inside the project's workspace once symbolic links
 * are followed. False when it is not, or when it does not exist.
 */
export async function realPathInsideWorkspace(projectId: string, target: string): Promise<boolean> {
  const { realpath } = await import('fs/promises')
  try {
    const [root, real] = await Promise.all([realpath(projectWorkspaceDir(projectId)), realpath(target)])
    return real.startsWith(root + path.sep)
  } catch {
    return false
  }
}
