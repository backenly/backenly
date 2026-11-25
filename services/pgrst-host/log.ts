/**
 * One line per event, each about one project, prefixed with its id.
 *
 * Nothing secret is written: never a token, a request body or a connection
 * string. A child's own output passes through `redact`, which removes the
 * authenticator's password, the JWT secret and anything shaped like a
 * connection URI, in case PostgREST ever prints one.
 */

export type LogLine = (line: string) => void

export const PREFIX = '[pgrst-host]'

export const consoleLog: LogLine = (line) => {
  process.stdout.write(`${line}\n`)
}

/** The longest child output line kept; the rest is cut. */
const MAX_LINE = 2000

/** Builds a function that removes the given secrets and every connection URI from a line. */
export function redactor(secrets: Array<string | undefined | null>): (line: string) => string {
  const literal = secrets
    .filter((s): s is string => typeof s === 'string' && s.length >= 4)
    // Longest first, so a secret that contains another is removed whole.
    .sort((a, b) => b.length - a.length)
  return (line) => {
    let out = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}...` : line
    out = out.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[connection uri]')
    for (const secret of literal) out = out.split(secret).join('[redacted]')
    return out
  }
}

/** The password in a connection URI, decoded, so it can be redacted however it is printed. */
export function uriPassword(uri: string): string | null {
  try {
    const url = new URL(uri)
    if (!url.password) return null
    return decodeURIComponent(url.password)
  } catch {
    return null
  }
}

export function projectLine(projectId: string, message: string): string {
  return `${PREFIX} ${projectId} ${message}`
}
