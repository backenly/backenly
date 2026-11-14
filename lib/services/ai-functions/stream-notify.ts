/**
 * A route module's own realtime events, sent on the project's stream.
 *
 * Generated job endpoints announce their events with
 * `prisma.$executeRawUnsafe('SELECT pg_notify($1, $2)', 'workspace_<id>_changes', payload)`
 * (lib/ai/build-runtime/domain-business-logic.ts), and functions already
 * stored keep that code. The stream is carried on a channel the platform
 * keeps (lib/realtime/channels.ts), which the function's login is never
 * given, so that one statement, naming the project's own stream label, is
 * sent to the project's channel by the platform instead. Every other
 * statement runs as written, on the function's login.
 */

import { notifyProjectChannel } from '@/lib/realtime/channels'
import { workspaceChannelName } from '@/lib/security/workspace-schema'
import type { RlsAwarePrisma } from './rls-aware-db'

const NOTIFY_STATEMENT = /^\s*select\s+(?:pg_catalog\s*\.\s*)?pg_notify\s*\(\s*\$1\s*,\s*\$2\s*\)\s*;?\s*$/i

export function withProjectStreamNotify(projectId: string, db: RlsAwarePrisma): RlsAwarePrisma {
  let label: string | null | undefined
  const ownLabel = (): string | null => {
    if (label === undefined) {
      try {
        label = workspaceChannelName(projectId)
      } catch {
        label = null
      }
    }
    return label
  }
  const toStream = (sql: unknown, values: unknown[]): boolean =>
    typeof sql === 'string' && values.length === 2 && values[0] === ownLabel() && NOTIFY_STATEMENT.test(sql)
  const send = (values: unknown[]) => notifyProjectChannel(projectId, String(values[1] ?? ''))

  return {
    ...db,
    $executeRawUnsafe: async (sql: string, ...values: any[]) => {
      if (!toStream(sql, values)) return db.$executeRawUnsafe(sql, ...values)
      await send(values)
      return 1
    },
    $queryRawUnsafe: async (sql: string, ...values: any[]) => {
      if (!toStream(sql, values)) return db.$queryRawUnsafe(sql, ...values)
      await send(values)
      return [{ pg_notify: '' }]
    },
  }
}
