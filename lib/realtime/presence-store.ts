/**
 * The presence table of a project, and the trigger that announces it.
 *
 * `_backenly_presence` in the workspace schema holds who is online. Its
 * trigger function announces a join, a leave or a change of metadata on the
 * project's realtime channel, which it reads when it runs
 * (presenceFunctionSql in lib/realtime/channel-sql.ts), so presence arrives on
 * the same stream as row changes. Shared by the presence routes of both
 * servers (app/api/v1/[projectId]/presence, server/routes/presence.ts).
 */

import type { WorkspaceRawClient } from '@/lib/data-plane/regional'
import { quoteIdent, workspaceSchemaName } from '@/lib/security/workspace-schema'
import { PRESENCE_FUNCTION_NAME, functionCommentSql, presenceFunctionSql } from './channel-sql'

/**
 * Projects this process has set up. The statements are idempotent, so a cold
 * start repeating them is safe; the listener hub keeps the function current
 * afterwards while the project has streams.
 */
const bootstrappedProjects = new Set<string>()

export async function ensurePresenceTable(db: WorkspaceRawClient, projectId: string): Promise<void> {
  if (bootstrappedProjects.has(projectId)) return

  const schema = workspaceSchemaName(projectId)
  const qSchema = quoteIdent(schema)

  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS ${qSchema}."_backenly_presence" (
      "userId"   TEXT        NOT NULL PRIMARY KEY,
      "metadata" JSONB       NOT NULL DEFAULT '{}',
      "joinedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "lastSeen" TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  // The function and the version it carries, together.
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(presenceFunctionSql(schema))
    await tx.$executeRawUnsafe(functionCommentSql(schema, PRESENCE_FUNCTION_NAME))
  })

  // Dropped first, so a trigger left from an older setup is replaced.
  await db.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS backenly_presence_notify ON ${qSchema}."_backenly_presence"
  `)
  await db.$executeRawUnsafe(`
    CREATE TRIGGER backenly_presence_notify
      AFTER INSERT OR UPDATE OR DELETE ON ${qSchema}."_backenly_presence"
      FOR EACH ROW EXECUTE FUNCTION ${qSchema}.${PRESENCE_FUNCTION_NAME}()
  `)

  bootstrappedProjects.add(projectId)
}
