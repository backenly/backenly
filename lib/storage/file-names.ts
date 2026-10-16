/**
 * A REGIONAL PROJECT'S FILE NAMES STAY IN ITS REGION
 * ==================================================
 * A stored file's name is often its end user's own words ("passport-jane.pdf").
 * Its row (storage_files) is a platform row, in the home region. For a project
 * kept in another region (lib/data-plane/regional.ts) the row keeps a stand-in
 * instead: a keyed hash of the name, per project, which keeps the file's
 * extension. "Is there already a file called X in this bucket?" is then still
 * one query on the row, by the stand-in of X, while the names themselves are
 * kept in the region (lib/data-plane/regional-bodies.ts, kind storage_file),
 * under the file's id, and read from there by whatever shows them.
 *
 * A home project's rows keep the real names, as they always have.
 *
 * Whether a project is regional is asked of its row, and a failed lookup is an
 * error: a home project's names are never hashed by mistake, and a regional
 * project's are never written in clear.
 */

import { createHmac } from 'crypto'
import { projectRegion } from '@/lib/data-plane/regional'
import { regionalBodiesFor } from '@/lib/data-plane/regional-bodies'
import { HOME_REGION } from '@/lib/regions'

/** A file's names, as its owner gave them. */
export interface FileNames {
  name: string
  originalName: string
}

async function isRegional(projectId: string): Promise<boolean> {
  return (await projectRegion(projectId)) !== HOME_REGION
}

/** The extension a stand-in keeps: short, plain, and lower-case, or none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  const ext = name.slice(dot).toLowerCase()
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ''
}

/** The stand-in a regional project's row keeps for `name`. */
export function fileNameStandIn(projectId: string, name: string): string {
  const key = process.env.ENV_VAR_ENCRYPTION_KEY || process.env.JWT_SECRET
  if (!key) throw new Error('No key for file name stand-ins: set ENV_VAR_ENCRYPTION_KEY or JWT_SECRET.')
  const digest = createHmac('sha256', key).update(`backenly:storage-file-name:v1:${projectId}:${name}`).digest('base64url')
  return `f_${digest.slice(0, 32)}${extensionOf(name)}`
}

/** What a row stores for `name`: the name itself at home, its stand-in elsewhere. */
export async function storedFileName(projectId: string, name: string): Promise<string> {
  return (await isRegional(projectId)) ? fileNameStandIn(projectId, name) : name
}

/**
 * The row's two name columns for a file with these names, after keeping the
 * names in the region when the project is kept there. Called BEFORE the row is
 * written, with the id the row then takes, so a row never exists without its
 * names.
 */
export async function keepFileNames(projectId: string, fileId: string, names: FileNames): Promise<FileNames> {
  if (!(await isRegional(projectId))) return names
  const bodies = await regionalBodiesFor(projectId)
  await bodies.set('storage_file', fileId, { payload: names })
  return {
    name: fileNameStandIn(projectId, names.name),
    // A row that never had an original name keeps none.
    originalName: names.originalName ? fileNameStandIn(projectId, names.originalName) : '',
  }
}

/**
 * Rows with their real names, read from the region for a regional project. A
 * row whose names the region does not have keeps its stand-in, which is still
 * a name it can be found by.
 */
export async function withFileNames<T extends { id: string; name: string; originalName?: string }>(
  projectId: string,
  rows: T[],
): Promise<T[]> {
  if (rows.length === 0 || !(await isRegional(projectId))) return rows
  const bodies = await regionalBodiesFor(projectId)
  const kept = await bodies.getMany('storage_file', rows.map((r) => r.id))
  return rows.map((row) => {
    const names = kept.get(row.id)?.payload as Partial<FileNames> | undefined
    if (typeof names?.name !== 'string') return row
    return {
      ...row,
      name: names.name,
      ...(row.originalName !== undefined && typeof names.originalName === 'string' ? { originalName: names.originalName } : {}),
    }
  })
}

/** One row with its real names. */
export async function withFileName<T extends { id: string; name: string; originalName?: string }>(
  projectId: string,
  row: T,
): Promise<T> {
  return (await withFileNames(projectId, [row]))[0]
}

/**
 * The ids of a regional project's files whose name contains `term` (any case)
 * or starts with it (exact case), searched in the region; null for a home
 * project, whose rows are searched by name as before.
 */
export async function fileIdsNamed(projectId: string, term: string, how: 'contains' | 'starts'): Promise<string[] | null> {
  if (!(await isRegional(projectId))) return null
  const bodies = await regionalBodiesFor(projectId)
  return bodies.idsMatching('storage_file', 'name', term, how)
}

/** Forget the names of files whose rows are being deleted for good. */
export async function forgetFileNames(projectId: string, fileIds: string[]): Promise<void> {
  if (fileIds.length === 0 || !(await isRegional(projectId))) return
  const bodies = await regionalBodiesFor(projectId)
  await bodies.remove('storage_file', fileIds)
}
