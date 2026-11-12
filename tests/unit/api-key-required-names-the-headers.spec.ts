/**
 * A request without an API key is told to send one in a header. The message
 * used to offer "?apiKey= query param" as well: a key in a URL ends up in
 * server logs, proxies and browser history (production QA, 2026-11-09). The
 * parameter is still read for EventSource, which cannot set headers.
 */
import '../helpers/real-web-standard'
import { NextRequest } from 'next/server'
import { authenticateApiKey } from '@/lib/middleware/apiKeyAuth'

it('names the headers, and never offers the key in a URL', async () => {
  const result = await authenticateApiKey(new NextRequest('http://localhost:3000/api/v1/p1/db/orders'))
  expect(result.authenticated).toBe(false)
  expect(result.error).toBe('API key required. Send it in the x-api-key header or as Authorization: Bearer <key>.')
})
