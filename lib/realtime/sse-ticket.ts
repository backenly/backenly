/**
 * SHORT-LIVED SSE TICKETS
 * =======================
 * `EventSource` cannot send request headers. Every browser realtime client
 * therefore has to put its credential in the URL — and the credential the SDK
 * used was the project API key, with the end-user's JWT alongside it for clients
 * that hand-rolled the connection.
 *
 * A URL is the worst place for a long-lived credential. It lands in nginx access
 * logs, in any proxy or CDN in front of the app, in the browser's history, and in
 * `Referer` headers on outbound links. A leaked end-user JWT is a full session;
 * a leaked API key is the whole project.
 *
 * A ticket fixes the shape rather than the symptom:
 *
 *   1. The client POSTs to /realtime/ticket with NORMAL headers — `Authorization:
 *      Bearer <apiKey>` and, when signed in, `X-User-Token: <jwt>`. Neither ever
 *      appears in a URL.
 *   2. It gets back an opaque token that is valid for 30 seconds and for ONE
 *      connection.
 *   3. It opens `GET /realtime?ticket=<ticket>`. What leaks into the logs is a
 *      string that was already spent by the time anyone reads them.
 *
 * The ticket is a compact JWT signed with the PROJECT's own secret, so it cannot
 * be replayed against another project even if the platform secret leaks. It
 * carries the end-user id, which is what lets a realtime stream be scoped to a
 * caller at all — the header-based identity was simply unavailable to
 * `EventSource` before.
 *
 * Single-use is enforced through the project's existing `_token_blacklist`
 * table rather than process memory, so it holds across the Next and Express
 * runtimes that both serve this route. If that table cannot be reached the
 * ticket degrades to "short-lived but replayable within 30s" and SAYS SO in the
 * response — a security property that silently stops holding is worse than one
 * that was never claimed.
 */

import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'

/** Deliberately short: long enough for a slow handshake, too short to harvest. */
export const SSE_TICKET_TTL_SECONDS = 30

export interface SseTicketClaims {
  /** Project this ticket is valid for. Never cross-project. */
  projectId: string
  /** The API key id the ticket was minted from, for audit and revocation. */
  keyId?: string | null
  /** End-user id, when the minting request carried an X-User-Token. */
  endUserId?: string | null
  /** End-user role claim, mirrored so the stream can scope without a re-verify. */
  endUserRole?: string | null
  /** True when the minting key was a service-role key (bypasses RLS scoping). */
  serviceRole?: boolean
}

export interface MintedTicket {
  ticket: string
  expiresIn: number
  /** False when single-use could not be armed — the caller must be told. */
  singleUse: boolean
}

/**
 * Mint a ticket for an ALREADY AUTHENTICATED request.
 *
 * This function performs no authentication of its own: the caller has run the v1
 * middleware and holds a verified project + key + end-user identity. Minting a
 * ticket is exactly "re-encode what we already proved, briefly".
 */
export async function mintSseTicket(
  projectJwtSecret: string,
  claims: SseTicketClaims,
): Promise<MintedTicket> {
  const jti = randomUUID()
  const ticket = jwt.sign(
    {
      typ: 'sse',
      jti,
      projectId: claims.projectId,
      keyId: claims.keyId ?? null,
      userId: claims.endUserId ?? null,
      role: claims.endUserRole ?? null,
      svc: !!claims.serviceRole,
    },
    projectJwtSecret,
    { algorithm: 'HS256', expiresIn: SSE_TICKET_TTL_SECONDS },
  )

  // Arm single-use by ensuring the ledger exists NOW rather than on redemption.
  // Creating it lazily at redeem time would mean the very first ticket of a
  // project's life is always replayable, which is not a property worth shipping.
  const armed = await ensureTicketLedger(claims.projectId)

  return { ticket, expiresIn: SSE_TICKET_TTL_SECONDS, singleUse: armed }
}

export type TicketRedemption =
  | { ok: true; claims: Required<Pick<SseTicketClaims, 'projectId'>> & SseTicketClaims; singleUseEnforced: boolean }
  | { ok: false; code: 'INVALID' | 'EXPIRED' | 'WRONG_PROJECT' | 'ALREADY_USED'; message: string }

/**
 * Verify a ticket and burn it.
 *
 * Burning happens BEFORE the stream opens, so a replay loses the race rather
 * than winning it: the insert is the atomic act (`ON CONFLICT DO NOTHING` +
 * rowcount), not a read-then-write.
 */
export async function redeemSseTicket(
  projectId: string,
  projectJwtSecret: string,
  ticket: string,
): Promise<TicketRedemption> {
  let payload: any
  try {
    payload = jwt.verify(ticket, projectJwtSecret, { algorithms: ['HS256'] })
  } catch (err: any) {
    return err?.name === 'TokenExpiredError'
      ? {
          ok: false,
          code: 'EXPIRED',
          message:
            `This realtime ticket has expired (they last ${SSE_TICKET_TTL_SECONDS}s). ` +
            `Mint a fresh one with POST /api/v1/${projectId}/realtime/ticket and reconnect.`,
        }
      : { ok: false, code: 'INVALID', message: 'Realtime ticket is not valid for this project.' }
  }

  if (payload?.typ !== 'sse' || !payload?.jti) {
    return {
      ok: false,
      code: 'INVALID',
      message: 'That token is not a realtime ticket. Mint one with POST /realtime/ticket.',
    }
  }
  if (payload.projectId !== projectId) {
    return { ok: false, code: 'WRONG_PROJECT', message: 'Realtime ticket was issued for a different project.' }
  }

  const burn = await burnTicket(projectId, String(payload.jti), Number(payload.exp) || 0)
  if (burn === 'already_used') {
    return {
      ok: false,
      code: 'ALREADY_USED',
      message:
        'This realtime ticket has already been redeemed. Tickets are single-use — mint a new one per ' +
        'connection (that is what makes a ticket in a URL safe).',
    }
  }

  return {
    ok: true,
    claims: {
      projectId,
      keyId: payload.keyId ?? null,
      endUserId: payload.userId ?? null,
      endUserRole: payload.role ?? null,
      serviceRole: !!payload.svc,
    },
    singleUseEnforced: burn === 'burned',
  }
}

/**
 * The redemption ledger reuses `_token_blacklist` — same shape, same lifecycle,
 * same pruning. A second near-identical table would be one more thing to keep in
 * sync for no gain; a spent ticket IS a revoked token.
 */
async function ensureTicketLedger(projectId: string): Promise<boolean> {
  const schemaName = `workspace_${projectId}`
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}"."_token_blacklist" (
        jti        TEXT        PRIMARY KEY,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    return true
  } catch {
    return false
  }
}

async function burnTicket(
  projectId: string,
  jti: string,
  exp: number,
): Promise<'burned' | 'already_used' | 'unenforced'> {
  const schemaName = `workspace_${projectId}`
  const expiresAt = exp ? new Date(exp * 1000) : new Date(Date.now() + SSE_TICKET_TTL_SECONDS * 1000)
  try {
    // Cheap opportunistic prune — tickets expire in 30s, so this table would
    // otherwise accumulate one row per realtime connection forever.
    await prisma.$executeRawUnsafe(
      `DELETE FROM "${schemaName}"."_token_blacklist" WHERE expires_at < NOW() - INTERVAL '1 hour'`,
    )
    const inserted = await prisma.$executeRawUnsafe(
      `INSERT INTO "${schemaName}"."_token_blacklist" (jti, expires_at)
       VALUES ($1, $2)
       ON CONFLICT (jti) DO NOTHING`,
      jti,
      expiresAt,
    )
    return inserted === 1 ? 'burned' : 'already_used'
  } catch {
    // The ledger is unreachable. The ticket is still short-lived and still
    // project-scoped; it is just replayable inside its 30s window. Reported, not
    // hidden — see the note at the top of this file.
    return 'unenforced'
  }
}
