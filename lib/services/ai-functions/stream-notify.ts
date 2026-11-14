/**
 * A route module's own realtime events, sent on the project's stream.
 *
 * Generated job endpoints announce their events with
 * `prisma.$executeRawUnsafe('SELECT pg_notify($1, $2)', 'workspace_<id>_changes', payload)`
 * (lib/ai/build-runtime/domain-business-logic.ts), and functions already
 * stored keep that code. The stream is carried on a channel the platform
 * keeps (lib/realtime/channels.ts), which the function's login is never
 * given, so that one statement, naming the project's own stream label, is
 * sent to the project's channel by the platform instead.
 *
 * The runner (isolation/function-runner.cjs, NOTIFY_STATEMENT) recognises the
 * statement, `SELECT pg_notify($1, $2)` with the label this module gives it as
 * `$1`, and asks the app to send it; every other statement runs as written, on
 * the function's login.
 */

import { notifyProjectChannel } from '@/lib/realtime/channels'
import { workspaceChannelName } from '@/lib/security/workspace-schema'

/** The project's own stream label, or null for an id that has none. */
export function projectStreamLabel(projectId: string): string | null {
  try {
    return workspaceChannelName(projectId)
  } catch {
    return null
  }
}

/** Send a route module's event to its project's stream. */
export async function sendToProjectStream(projectId: string, payload: string): Promise<void> {
  await notifyProjectChannel(projectId, payload)
}
