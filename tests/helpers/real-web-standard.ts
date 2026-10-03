/**
 * Put the runtime's real Request, Response and Headers back for this file.
 *
 * jest.setup.js replaces them with small stand-ins that most suites were
 * written against. The MCP SDK is built on the real ones: it clones requests to
 * classify them and streams responses. Testing it on the stand-ins would test
 * the stand-ins. jest gives every test file its own globals, so restoring them
 * here changes nothing for any other suite.
 *
 * Import this before anything that imports `next/server`: NextRequest captures
 * the global Request when that module first loads.
 */

const real = (globalThis as any).__realWebStandard as
  | { Request?: typeof Request; Response?: typeof Response; Headers?: typeof Headers; fetch?: typeof fetch }
  | undefined

if (!real?.Request || !real.Response || !real.Headers) {
  throw new Error('The real web-standard classes were not captured; see jest.setup.js.')
}

Object.assign(globalThis, {
  Request: real.Request,
  Response: real.Response,
  Headers: real.Headers,
  ...(real.fetch ? { fetch: real.fetch } : {}),
})

export {}
