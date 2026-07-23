/**
 * Auth/signature headers that invocation surfaces forward into route-module
 * function handlers. Generated route modules read x-user-token / x-admin-key /
 * authorization directly — without forwarding, their auth gates can never
 * pass, no matter what the caller sends. `cookie` is forwarded because the
 * runner exposes NextRequest-compatible `request.cookies` and generated
 * handlers legitimately read their own app's session cookies. Everything else
 * (platform session headers, infra headers) is deliberately dropped.
 */
export const FORWARDABLE_FN_HEADERS = [
  'authorization',
  'x-user-token',
  'x-admin-key',
  'x-api-key',
  'content-type',
  'cookie',
  'stripe-signature',
  'x-webhook-signature',
  'x-signature',
] as const

/**
 * Extract the forwardable subset from any header source. Pass a getter so the
 * same helper serves NextRequest (`req.headers.get`) and Express
 * (`name => req.headers[name]`).
 */
export function pickFnHeaders(
  get: (name: string) => string | string[] | null | undefined
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of FORWARDABLE_FN_HEADERS) {
    const v = get(name)
    const s = Array.isArray(v) ? v[0] : v
    if (typeof s === 'string' && s) out[name] = s
  }
  return out
}
