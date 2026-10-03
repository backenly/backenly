/**
 * The credential a delegated MCP handler must receive.
 *
 * The remote endpoint (`app/api/mcp/route.ts`) answers `tools/call` by building
 * a new request for `/api/mcp/tool` or `/api/mcp/chat` and running that handler
 * in-process. Whatever authenticated the caller has to travel on that new
 * request, because the delegated handler authenticates again from scratch.
 *
 * It used to copy `x-api-key` alone. An OAuth host sends no x-api-key at all,
 * only `Authorization: Bearer <token>`, so `initialize` and `tools/list` (which
 * authenticate the original request) succeeded while every `tools/call` reached
 * the handler with an empty key and came back NO_AUTH. The connection looked
 * healthy and could not do anything.
 *
 * Both headers are copied as the caller sent them. `authenticateMcp` already
 * decides between them (a Bearer token wins), so the delegated call is judged
 * exactly as a direct call to that handler would be. Nothing else is forwarded:
 * cookies and other headers are not credentials for these routes.
 */
export function forwardedCredentialHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  const authorization = headers.get('authorization')
  if (authorization) out.authorization = authorization
  const apiKey = headers.get('x-api-key')
  if (apiKey) out['x-api-key'] = apiKey
  return out
}
