/**
 * The words the console shows for who sent each file (lib/storage/uploader.ts).
 *
 * Server only: an end user is named by their email from the project's own
 * users table, in the project's region, the way the console's Users page reads
 * it; a key by its name; a console upload by the account's name. Every lookup
 * is one query per page of files, and a lookup that fails leaves the kind's
 * plain words rather than failing the listing.
 */
import { prisma } from '@/lib/db'
import { introspectAuthUsersTable } from '@/lib/services/end-user-auth-table'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import type { UploaderKind, UploaderRecord } from './uploader'

export interface UploaderView {
  kind: UploaderKind
  label: string
}

const unique = (values: Array<string | null | undefined>) => Array.from(new Set(values.filter((v): v is string => !!v)))

async function endUserEmails(projectId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  try {
    const table = await introspectAuthUsersTable(projectId)
    if (!table.columns.has('email')) return new Map()
    const rows = await executeWithUserContext<{ id: string; email: string | null }>(
      projectId,
      '',
      true,
      `SELECT id::text AS id, email FROM "${table.schemaName}"."users" WHERE id::text = ANY($1::text[])`,
      [ids],
    )
    return new Map(rows.filter((r) => r.email).map((r) => [r.id, r.email as string]))
  } catch {
    return new Map()
  }
}

/** One view per file, in order; null where nothing was recorded. */
export async function describeUploaders(
  projectId: string,
  files: Array<{ uploadedBy: string | null; uploader: UploaderRecord | null }>,
): Promise<Array<UploaderView | null>> {
  const endUserIds = unique(files.filter((f) => f.uploader?.kind === 'end_user').map((f) => f.uploadedBy))
  const keyIds = unique(files.map((f) => f.uploader?.apiKeyId))
  const accountIds = unique(files.map((f) => f.uploader?.platformUserId))

  const findKeys = async (): Promise<Array<{ id: string; name: string }>> =>
    keyIds.length
      ? prisma.apiKey.findMany({ where: { id: { in: keyIds }, projectId }, select: { id: true, name: true } }).catch(() => [])
      : []
  const findAccounts = async (): Promise<Array<{ id: string; name: string | null; email: string }>> =>
    accountIds.length
      ? prisma.user.findMany({ where: { id: { in: accountIds } }, select: { id: true, name: true, email: true } }).catch(() => [])
      : []
  const [emails, keys, accounts] = await Promise.all([endUserEmails(projectId, endUserIds), findKeys(), findAccounts()])
  const keyName = new Map(keys.map((k) => [k.id, k.name] as const))
  const account = new Map(accounts.map((a) => [a.id, a.name || a.email] as const))

  return files.map((f) => {
    const u = f.uploader
    if (!u) return null
    switch (u.kind) {
      case 'end_user':
        return { kind: u.kind, label: (f.uploadedBy && emails.get(f.uploadedBy)) || 'Signed-in user' }
      case 'anonymous':
        return { kind: u.kind, label: 'Anonymous' }
      case 'server_key': {
        const name = u.apiKeyId ? keyName.get(u.apiKeyId) : undefined
        return { kind: u.kind, label: name ? `Server key “${name}”` : 'Server key' }
      }
      case 'console':
        return { kind: u.kind, label: (u.platformUserId && account.get(u.platformUserId)) || 'Console' }
    }
  })
}
