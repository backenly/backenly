/**
 * A Content-Security-Policy-Report-Only header is sent only with somewhere to
 * send its reports.
 *
 * Production QA re-test, 2026-11-16, N13: the MCP consent page logged about 13
 * Content-Security-Policy errors for its own scripts and styles. They came
 * from a report-only policy sent on every page (next.config.js): nonce-less
 * 'strict-dynamic' and no 'unsafe-inline' for styles, which every Next page
 * breaks, and no report-to or report-uri, so browsers had nowhere to send the
 * reports. Without one, MDN says, sending them "won't have any effect"; the
 * only thing it did was print an error per script, inline script and style
 * attribute.
 */
const config = require('../../next.config.js')

type Header = { key: string; value: string }

async function headers(): Promise<Header[]> {
  const rules: Array<{ source: string; headers: Header[] }> = await config.headers()
  return rules.flatMap((r) => r.headers)
}

it('sends no report-only policy without a report-to or report-uri directive', async () => {
  const reportOnly = (await headers()).filter((h) => h.key.toLowerCase() === 'content-security-policy-report-only')
  for (const policy of reportOnly) {
    expect(policy.value).toMatch(/(^|;\s*)report-(to|uri)\s+\S+/)
  }
})

it('CONTROL: keeps the enforced policy as it was', async () => {
  const rules: Array<{ source: string; headers: Header[] }> = await config.headers()
  const enforced = rules
    .filter((r) => r.source === '/:path*')
    .flatMap((r) => r.headers)
    .filter((h) => h.key === 'Content-Security-Policy')
  expect(enforced).toHaveLength(1)
  // The only other enforced policy is the one every answer on a function's
  // path carries (tests/unit/function-answers-are-data.spec.ts).
  const elsewhere = rules
    .filter((r) => r.source !== '/:path*')
    .flatMap((r) => r.headers)
    .filter((h) => h.key === 'Content-Security-Policy')
  expect(new Set(elsewhere.map((h) => h.value))).toEqual(new Set(["sandbox; default-src 'none'"]))
  for (const directive of [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "frame-ancestors 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ]) {
    expect(enforced[0].value).toContain(directive)
  }
})
