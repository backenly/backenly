/**
 * Signed authorization-request tokens for the MCP consent round-trip.
 *
 * Split out of the authorize route because the consent page needs the same two
 * functions, and importing them from a route module would drag a route handler
 * into a page's module graph. Shared code belongs in lib; a route file should
 * export handlers and nothing else.
 *
 * Two token types, and the difference between them is the CSRF defence:
 *
 *   `mcp_authz_request` — issued by GET /authorize once the client and redirect
 *     URI are verified. Describes the request. Carries no user.
 *
 *   `mcp_authz_confirm` — issued by the consent page, which knows who is signed
 *     in, and therefore carries `uid`. POST /authorize requires one of these AND
 *     that the live session matches its `uid`, so an approval cannot be replayed
 *     from another origin against a logged-in victim.
 *
 * Both are short-lived and signed with JWT_SECRET. They are not credentials —
 * neither one grants access to anything on its own.
 */

import jwt, { SignOptions } from 'jsonwebtoken'

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is not set')
const JWT_SECRET = process.env.JWT_SECRET

export const REQ_TYP = 'mcp_authz_request'
export const CONFIRM_TYP = 'mcp_authz_confirm'
export const REQUEST_TTL_SEC = 10 * 60

export interface AuthzRequest {
  typ: string
  client_id: string
  redirect_uri: string
  code_challenge: string
  scope: string
  state?: string
  resource?: string
  /** Present only on a confirm token: the user who was shown the consent page. */
  uid?: string
}

export function signAuthzToken(payload: Omit<AuthzRequest, 'typ'>, typ: string): string {
  return jwt.sign({ ...payload, typ }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: REQUEST_TTL_SEC,
  } as SignOptions)
}

export function verifyAuthzToken(token: string, expectedTyp: string): AuthzRequest | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as AuthzRequest
    if (decoded.typ !== expectedTyp) return null
    return decoded
  } catch {
    return null
  }
}
