/**
 * Ticket authorization for the realtime SSE routes.
 *
 * Both runtimes serve `GET /api/v1/:projectId/realtime` — the Next route in dev,
 * the Express route in production — so the ticket check lives here and is called
 * by both. Two copies of a credential check is how one of them ends up lenient.
 */

import { resolveJwtSecret } from '@/lib/services/jwtSecretManager'
import { redeemSseTicket, type TicketRedemption } from './sse-ticket'
import { authorizingProject } from '@/lib/auth-projection/read'

/**
 * Redeem a `?ticket=` query parameter.
 *
 * Returns the same discriminated result the underlying redeemer returns, plus
 * the project-secret failure case: a project with no signing secret cannot have
 * issued a ticket, so a ticket presented for it is necessarily forged.
 */
export async function redeemRealtimeTicketParam(
  projectId: string,
  ticket: string,
): Promise<TicketRedemption> {
  // From the region's copy while it is fresh. A failure, including one to
  // authorize at all, is a ticket this project cannot be shown to have issued.
  const project = await authorizingProject(projectId).catch(() => null)

  if (!project?.jwtSecret) {
    return {
      ok: false,
      code: 'INVALID',
      message:
        'This project has no JWT signing secret, so it has never issued a realtime ticket. ' +
        'Authenticate with an API key, or enable end-user auth and mint a ticket with ' +
        `POST /api/v1/${projectId}/realtime/ticket.`,
    }
  }

  return redeemSseTicket(projectId, resolveJwtSecret(project.jwtSecret), ticket)
}
