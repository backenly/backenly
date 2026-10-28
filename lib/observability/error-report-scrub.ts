/**
 * WHAT AN ERROR REPORT MAY CARRY OFF THE PLATFORM
 * ===============================================
 * Sentry is a third party. A report goes there with whatever context the code
 * that raised it attached, and with what the SDK gathers on its own: console
 * output and outgoing requests as breadcrumbs, the request being served, the
 * spans of a sampled transaction. Customers' data belongs in none of it: no
 * rows of their tables, no request bodies, no credentials, no query strings
 * (the realtime stream and OAuth callbacks carry tickets and tokens in them),
 * no webhook receiver's path (often its secret), no client addresses.
 *
 * Code that reports an error attaches identifiers only (project, trigger,
 * table, event type). This is the second line: every report, transaction and
 * span passes through it, so customer data is removed even when a call site,
 * or an SDK default, gets it wrong.
 */

/** Keys that, by their name, hold customer data (matched on the last dotted part). */
const CUSTOMER_DATA_KEYS = new Set([
  'event', 'data', 'old', 'new', 'record', 'records', 'row', 'rows', 'payload', 'body',
  'values', 'input', 'output', 'args', 'arguments', 'params', 'query', 'fragment', 'result',
  'messages', 'prompt', 'completion', 'text',
  // A thrown or rejected value that is not an Error, which the SDK sends whole.
  '__serialized__',
])

/** Keys that hold a credential, wherever the word appears in the name. */
const CREDENTIAL_KEY = /password|passwd|secret|token(?!s|_?count)|api_?key|authorization|cookie|credential|signature|session/i

/** Request headers that carry a credential or the client's address. */
const PRIVATE_HEADER = /authorization|cookie|token|key|secret|signature|session|forwarded|real-ip|client-ip|connecting-ip/i

/** A path segment that is a route word or an id. Anything else (a token, a file name, an address) is removed. */
const ROUTE_SEGMENT = /^[A-Za-z0-9_-]{1,31}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A route's parameter as Next.js names it in a transaction (`[projectId]`, `[...path]`). */
const ROUTE_PARAM = /^\[{1,2}(?:\.\.\.)?[A-Za-z0-9_]{1,40}\]{1,2}$/

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi
const REQUEST_LINE = /^([A-Z]+) (\S+)([\s\S]*)$/

/** Deeper than the SDK's own normalisation ever sends; anything below is dropped. */
const MAX_DEPTH = 8

export const REMOVED = '[removed]'

type Dict = Record<string, unknown>

interface ReportSpan {
  op?: string
  description?: string
  data?: Dict
}

/** The parts of a Sentry event this touches; the rest passes through as it is. */
export interface ScrubbableReport {
  message?: unknown
  exception?: { values?: Array<{ value?: string; stacktrace?: { frames?: Array<{ vars?: unknown }> } }> }
  extra?: Dict
  contexts?: Record<string, unknown>
  tags?: Record<string, unknown>
  user?: Dict
  request?: {
    url?: string
    data?: unknown
    cookies?: unknown
    env?: unknown
    query_string?: unknown
    headers?: Record<string, string>
  }
  breadcrumbs?: Array<{ category?: string; message?: string; data?: Dict }>
  spans?: ReportSpan[]
}

/** A URL without its query string and fragment, which can carry tokens and keys. */
export function withoutQuery(url: string): string {
  const cut = url.search(/[?#]/)
  return cut === -1 ? url : url.slice(0, cut)
}

/** Whether a host is this platform's own, by the address it is served at. */
function isOwnHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true
  let app: string
  try {
    app = new URL(process.env.NEXT_PUBLIC_APP_URL ?? '').hostname
  } catch {
    return false
  }
  return hostname === app || hostname.endsWith(`.${app}`)
}

function scrubPath(path: string): string {
  return path
    .split('/')
    .map((segment) =>
      segment === '' || ROUTE_SEGMENT.test(segment) || UUID.test(segment) || ROUTE_PARAM.test(segment) ? segment : REMOVED,
    )
    .join('/')
}

/**
 * A URL as a report may carry it. Never its query string, fragment or
 * user:password part. A third party's URL keeps only its origin, because a
 * webhook receiver's path is often its secret. This platform's own path keeps
 * its route words and ids; `own` marks a URL known to be ours whatever its
 * host (the request being served).
 */
export function scrubUrl(url: string, own = false): string {
  const bare = withoutQuery(url)
  if (!ABSOLUTE_URL.test(bare)) return scrubPath(bare)
  let parsed: URL
  try {
    parsed = new URL(bare)
  } catch {
    return REMOVED
  }
  const origin = `${parsed.protocol}//${parsed.host}`
  return own || isOwnHost(parsed.hostname) ? origin + scrubPath(parsed.pathname) : origin
}

function scrubUrlsIn(text: string): string {
  return text.replace(URL_IN_TEXT, (url) => scrubUrl(url))
}

/** SQL with its literal values replaced: a statement's shape, none of a customer's values. */
export function withoutLiterals(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "'?'")
    .replace(/(^|[^\w$."])\d+(?:\.\d+)?(?![\w.])/g, '$1?')
}

function isPrivateKey(key: string): boolean {
  const last = key.slice(key.lastIndexOf('.') + 1).toLowerCase()
  return CUSTOMER_DATA_KEYS.has(last) || CREDENTIAL_KEY.test(key)
}

/** A copy with customer-data and credential keys removed and every URL scrubbed. */
function scrubbed(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubUrlsIn(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return REMOVED
  if (Array.isArray(value)) return value.map((item) => scrubbed(item, depth + 1))
  const copy: Dict = {}
  for (const [key, item] of Object.entries(value)) copy[key] = isPrivateKey(key) ? REMOVED : scrubbed(item, depth + 1)
  return copy
}

/** Span attributes, under the OpenTelemetry names the SDK records them by. */
function scrubSpanData(data: Dict): Dict {
  const peer = data['server.address'] ?? data['net.peer.name']
  const thirdParty = typeof peer === 'string' && !isOwnHost(peer)
  const copy: Dict = {}
  for (const [key, value] of Object.entries(data)) {
    if ((key === 'db.statement' || key === 'db.query.text') && typeof value === 'string') copy[key] = withoutLiterals(value)
    else if (isPrivateKey(key)) copy[key] = REMOVED
    else if ((key === 'url.path' || key === 'http.target') && typeof value === 'string') copy[key] = thirdParty ? REMOVED : scrubUrl(value)
    else if (typeof value === 'string' && ABSOLUTE_URL.test(value)) copy[key] = scrubUrl(value)
    else copy[key] = scrubbed(value, 1)
  }
  return copy
}

/** Remove customer data from one span: its description and its attributes. */
export function scrubReportSpan<T extends ReportSpan>(span: T): T {
  if (typeof span.description === 'string') {
    const line = REQUEST_LINE.exec(span.description)
    if (span.op?.startsWith('db')) span.description = withoutLiterals(span.description)
    else if (line && span.op?.startsWith('http')) span.description = `${line[1]} ${scrubUrl(line[2])}${scrubUrlsIn(line[3])}`
    else span.description = scrubUrlsIn(span.description)
  }
  if (span.data) span.data = scrubSpanData(span.data)
  return span
}

function scrubReport(report: ScrubbableReport): void {
  if (typeof report.message === 'string') report.message = scrubUrlsIn(report.message)
  for (const exception of report.exception?.values ?? []) {
    if (typeof exception.value === 'string') exception.value = scrubUrlsIn(exception.value)
    // A frame's local variables hold whatever the function was handling; they
    // stay off even if `includeLocalVariables` is ever turned on.
    for (const frame of exception.stacktrace?.frames ?? []) delete frame.vars
  }

  if (report.extra) report.extra = scrubbed(report.extra) as Dict

  if (report.contexts) {
    const contexts: Record<string, unknown> = {}
    for (const [name, context] of Object.entries(report.contexts)) {
      if (name === 'trace' && context && typeof context === 'object') {
        // The span the report belongs to: its ids pass, its attributes are scrubbed like any span's.
        const trace = { ...(context as Dict) }
        if (trace.data && typeof trace.data === 'object') trace.data = scrubSpanData(trace.data as Dict)
        contexts[name] = trace
      } else {
        contexts[name] = scrubbed(context)
      }
    }
    report.contexts = contexts
  }

  if (report.tags) {
    const tags: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(report.tags)) {
      tags[key] = isPrivateKey(key) ? REMOVED : typeof value === 'string' ? scrubUrlsIn(value) : value
    }
    report.tags = tags
  }

  // Which platform user an error hit is an id; nothing else about them leaves.
  if (report.user) {
    if (report.user.id === undefined) delete report.user
    else report.user = { id: report.user.id }
  }

  if (report.request) {
    const request = report.request
    delete request.data
    delete request.cookies
    delete request.env
    if (request.query_string !== undefined) request.query_string = REMOVED
    if (typeof request.url === 'string') request.url = scrubUrl(request.url, true)
    if (request.headers) {
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(request.headers)) {
        headers[name] = PRIVATE_HEADER.test(name) ? REMOVED : scrubUrlsIn(String(value))
      }
      request.headers = headers
    }
  }

  if (report.breadcrumbs) {
    report.breadcrumbs = report.breadcrumbs
      // Console output is whatever a log line printed, rows included.
      .filter((crumb) => crumb.category !== 'console')
      .map((crumb) => {
        const copy = { ...crumb }
        if (typeof copy.message === 'string') copy.message = scrubUrlsIn(copy.message)
        if (copy.data) {
          const data = scrubbed(copy.data) as Dict
          for (const key of ['url', 'from', 'to']) {
            if (typeof copy.data[key] === 'string') data[key] = scrubUrl(copy.data[key] as string)
          }
          copy.data = data
        }
        return copy
      })
  }

  for (const span of report.spans ?? []) scrubReportSpan(span)
}

/** Remove customer data and credentials from an error report or transaction. */
export function scrubErrorReport<T extends ScrubbableReport>(report: T): T {
  scrubReport(report)
  return report
}
