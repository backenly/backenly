/**
 * Reaching a source safely: a database or a Storage API at an address a person
 * typed into "Bring your backend".
 *
 * The importer runs inside Backenly, next to the platform's own database, the
 * PostgREST admin port and the cloud metadata service. A connection string is
 * therefore a request to open a socket from inside, and it is checked the way
 * lib/security/outbound-guard.ts checks a webhook:
 *
 *   - the host is resolved HERE, every address it answers with is checked, and
 *     the socket is opened to the checked address, never to the name again, so
 *     DNS cannot answer one way for the check and another for the connection;
 *   - private, loopback, link-local (the metadata service), CGNAT and the
 *     reserved ranges are refused, IPv4 and IPv6 alike, including IPv4 carried
 *     inside IPv6 (`outboundAddressRefusal`, scope `import`; only a self-hosted
 *     deployment may open private ranges, with BACKENLY_IMPORT_EGRESS_ALLOW_PRIVATE);
 *   - TLS names the host the person typed (`servername`), so a certificate is
 *     checked against that name although the socket was opened to an address;
 *   - a database is reached on port 5432 only, the one port Backenly Cloud's
 *     web task opens to the internet for this;
 *   - Supabase is only reached encrypted;
 *   - what the source sends is bounded before pg holds it: one message, and
 *     one statement's answer (lib/import/source-guard.ts);
 *   - every statement runs inside a READ ONLY transaction, so the source can
 *     only be read even if a statement Backenly sends were wrong.
 *
 * Nothing here logs, stores or returns a credential. Errors are said in the
 * source's own words, after lib/import/redact.ts has removed what they quoted.
 * A refused address is named by its kind, never by the address a name
 * resolved to: inside Backenly's network a name can resolve to an address
 * that is not anyone's business outside it.
 */

import * as dns from 'node:dns'
import * as net from 'node:net'
import { Client as PgClient, type ClientConfig } from 'pg'
import { outboundAddressRefusal, privateEgressAllowedFor } from '@/lib/security/outbound-guard'
import { ImportInputError } from './driver'
import { redactedMessage } from './redact'
import { SourceWireError, guardSourceClient } from './source-guard'

// ── Connection strings ────────────────────────────────────────────────────────

export type SslMode = 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full'
const SSL_MODES: readonly SslMode[] = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']

export interface ParsedPgUrl {
  /** The host as typed, without IPv6 brackets. */
  host: string
  port: number
  user: string
  password: string
  database: string
  sslmode: SslMode | null
}

const FIELD = 'connectionString' as const

/** The one port a source database is reached on: Backenly Cloud's web task opens no other to the internet for imports. */
export const SOURCE_PORT = 5432

function refuse(message: string): never {
  throw new ImportInputError(message, FIELD)
}

/**
 * Parse a postgres:// URL into the parts Backenly connects with. Anything that
 * would make the connection go somewhere other than the one host it names (a
 * second host, a Unix socket, `?host=`) is refused rather than ignored.
 */
export function parsePostgresUrl(raw: string): ParsedPgUrl {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) refuse('Paste the connection string.')
  if (!/^postgres(ql)?:\/\//i.test(text)) refuse('A connection string starts with postgresql://')
  // Several hosts (host1,host2) and an empty host (a Unix socket) never reach the URL parser.
  const authority = /^postgres(?:ql)?:\/\/([^/?#]*)/i.exec(text)?.[1] ?? ''
  const hostPart = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority
  if (!hostPart || hostPart.startsWith(':')) refuse('The connection string has no host. Backenly connects over the internet, never through a Unix socket.')
  if (hostPart.includes(',')) refuse('Use a connection string with one host.')
  const typedPort = /:(\d+)$/.exec(hostPart.replace(/^\[[^\]]*\]/, ''))
  if (typedPort && (Number(typedPort[1]) < 1 || Number(typedPort[1]) > 65535)) refuse('The port in the connection string is not a valid port.')

  let url: URL
  try {
    // The WHATWG parser only knows special schemes' hosts; postgres:// parses as an opaque host, which is enough.
    url = new URL(text)
  } catch {
    refuse("That connection string couldn't be read. Copy it again from the source's settings.")
  }

  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) refuse('The connection string has no host.')
  if (host.startsWith('/') || host.startsWith('%2F') || host.startsWith('%2f')) refuse('Unix-socket connection strings cannot be reached from Backenly. Use the database\'s internet address.')

  const port = url.port ? Number(url.port) : SOURCE_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65535) refuse('The port in the connection string is not a valid port.')
  if (port !== SOURCE_PORT) {
    refuse(
      isSupabaseHost(host)
        ? `Backenly connects to databases on port ${SOURCE_PORT} only, and this connection string names port ${port}. In Supabase, press Connect and copy the Session pooler string (port ${SOURCE_PORT}).`
        : `Backenly connects to databases on port ${SOURCE_PORT} only, and this connection string names port ${port}. Use an address of the database that answers on port ${SOURCE_PORT}.`,
    )
  }

  let user = ''
  let password = ''
  try {
    user = decodeURIComponent(url.username)
    password = decodeURIComponent(url.password)
  } catch {
    refuse("The user or password in the connection string couldn't be read. Copy it again.")
  }
  if (!user) refuse('The connection string has no user.')

  let database = url.pathname.replace(/^\//, '')
  try {
    database = decodeURIComponent(database)
  } catch {
    refuse("The database name in the connection string couldn't be read.")
  }
  if (!database) database = 'postgres'
  if (database.includes('/')) refuse('The connection string names more than one database.')

  for (const key of ['host', 'hostaddr', 'port', 'service', 'passfile']) {
    if (url.searchParams.has(key)) refuse(`Put the ${key === 'hostaddr' ? 'host' : key} in the address itself, not in ?${key}=.`)
  }
  const rawMode = url.searchParams.get('sslmode')
  let sslmode: SslMode | null = null
  if (rawMode !== null) {
    const m = rawMode.toLowerCase() as SslMode
    if (!SSL_MODES.includes(m)) refuse(`sslmode=${rawMode.slice(0, 20)} is not a mode PostgreSQL knows.`)
    sslmode = m
  }
  return { host, port, user, password, database, sslmode }
}

/** Supabase's database hosts: db.<ref>.supabase.co, and the pooler, *.pooler.supabase.com. */
export function isSupabaseHost(host: string): boolean {
  return /(^|\.)supabase\.(co|com)$/i.test(host.trim().replace(/\.$/, ''))
}

/** The project ref a Supabase connection names, from its host or its pooler user. */
export function supabaseRefOf(parsed: Pick<ParsedPgUrl, 'host' | 'user'>): string | null {
  const direct = /^db\.([a-z0-9]{8,40})\.supabase\.co$/i.exec(parsed.host)
  if (direct) return direct[1].toLowerCase()
  const pooled = /^postgres\.([a-z0-9]{8,40})$/i.exec(parsed.user)
  if (pooled && isSupabaseHost(parsed.host)) return pooled[1].toLowerCase()
  return null
}

// ── Addresses ─────────────────────────────────────────────────────────────────

export interface CheckedAddress {
  address: string
  family: 4 | 6
}

type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>

const systemLookup: Lookup = (host) => dns.promises.lookup(host, { all: true, verbatim: true })

/**
 * Resolve `host` and return an address the importer may connect to.
 *
 * Every address the name answers with must pass, not only the one used: a name
 * answering with one public and one private address would otherwise be
 * reachable on a retry or an address-family flip. An IPv4 address is preferred
 * when the name has both, since not every network Backenly runs on routes IPv6.
 */
export async function resolveCheckedAddress(
  host: string,
  opts: { field?: 'connectionString' | 'projectUrl'; lookup?: Lookup } = {},
): Promise<CheckedAddress> {
  const field = opts.field ?? FIELD
  const name = host.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  const literal = net.isIP(name)
  let list: Array<{ address: string; family: number }>
  if (literal) {
    list = [{ address: name, family: literal }]
  } else {
    try {
      list = await (opts.lookup ?? systemLookup)(name)
    } catch (err: any) {
      const code = err?.code
      if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'EAI_NONAME') {
        throw new ImportInputError(`Couldn't connect: ${name} was not found. Check the host.`, field)
      }
      throw new ImportInputError(`Couldn't connect: ${name} could not be looked up (${code ?? 'DNS error'}).`, field)
    }
  }
  if (list.length === 0) throw new ImportInputError(`Couldn't connect: ${name} did not resolve to an address.`, field)

  for (const a of list) {
    // The kind of address, never the address: a name may resolve to one only Backenly's network knows.
    const reason = outboundAddressRefusal(a.address, 'import')
    if (reason) {
      throw new ImportInputError(
        `Backenly only connects to sources on the public internet, and ${literal ? 'that' : name} is a ${reason}.`,
        field,
      )
    }
  }
  const chosen = list.find((a) => a.family === 4) ?? list[0]
  return { address: chosen.address, family: chosen.family === 6 ? 6 : 4 }
}

// ── Database connections ─────────────────────────────────────────────────────

export interface SourceConnectOptions {
  /** Encrypt whatever the connection string says (Supabase). */
  requireTls: boolean
  /** Removed from every error before it is said anywhere. */
  secrets: readonly string[]
  connectTimeoutMs?: number
  lookup?: Lookup
}

export const SOURCE_LIMITS = {
  connectTimeoutMs: 10_000,
  /** One statement on the source: a count of a large table is the slowest. */
  statementTimeoutMs: 120_000,
  /** A lock someone else holds is waited for this long, then the read fails rather than hangs. */
  lockTimeoutMs: 15_000,
}

/** A connected, read-only source. Close it with `end()`. */
export interface SourceConnection {
  client: PgClient
  host: string
  /** True when the connection is encrypted. */
  tls: boolean
  end(): Promise<void>
}

function tlsConfig(parsed: ParsedPgUrl, verify: 'full' | 'ca' | 'none'): ClientConfig['ssl'] {
  const named = net.isIP(parsed.host) ? {} : { servername: parsed.host }
  if (verify === 'none') return { ...named, rejectUnauthorized: false }
  if (verify === 'ca') return { ...named, rejectUnauthorized: true, checkServerIdentity: () => undefined }
  return { ...named, rejectUnauthorized: true }
}

const NO_SSL = /does not support SSL|server does not support ssl|The server does not support SSL connections/i

/**
 * Open a read-only connection to the source database.
 *
 * The socket goes to the address `resolveCheckedAddress` returned. Throws
 * ImportInputError with the source's own words when it cannot connect.
 */
export async function connectSource(parsed: ParsedPgUrl, opts: SourceConnectOptions): Promise<SourceConnection> {
  const mode = parsed.sslmode
  if (opts.requireTls && (mode === 'disable' || mode === 'allow')) {
    refuse(`Supabase is only reached over an encrypted connection: remove sslmode=${mode} from the connection string.`)
  }
  const { address, family } = await resolveCheckedAddress(parsed.host, { lookup: opts.lookup })

  // Which TLS to try, in order.
  const attempts: Array<ClientConfig['ssl'] | false> =
    mode === 'disable' ? [false]
    : mode === 'verify-full' ? [tlsConfig(parsed, 'full')]
    : mode === 'verify-ca' ? [tlsConfig(parsed, 'ca')]
    : mode === 'require' || opts.requireTls ? [tlsConfig(parsed, 'none')]
    // prefer / allow / unset: encrypted when the server can, as libpq does.
    : [tlsConfig(parsed, 'none'), false]

  let lastErr: unknown = null
  for (let i = 0; i < attempts.length; i++) {
    const ssl = attempts[i]
    const client = new PgClient({
      host: address,
      port: parsed.port,
      user: parsed.user,
      password: parsed.password,
      database: parsed.database,
      ssl: ssl || false,
      connectionTimeoutMillis: opts.connectTimeoutMs ?? SOURCE_LIMITS.connectTimeoutMs,
      query_timeout: SOURCE_LIMITS.statementTimeoutMs + 10_000,
      application_name: 'backenly-import',
      keepAlive: true,
    })
    // Before connect, so the startup exchange is bounded too.
    guardSourceClient(client)
    // An error after connect (the source restarting) must not crash the process.
    client.on('error', () => {})
    try {
      await client.connect()
      return {
        client,
        host: parsed.host,
        tls: !!ssl,
        end: async () => {
          await client.end().catch(() => {})
        },
      }
    } catch (err) {
      lastErr = err
      await client.end().catch(() => {})
      const fallBack = i + 1 < attempts.length && NO_SSL.test(String((err as Error)?.message ?? ''))
      if (!fallBack) break
    }
  }
  throw new ImportInputError(describeSourceError(lastErr, { host: parsed.host, port: parsed.port, family, secrets: opts.secrets }), FIELD)
}

/**
 * A connection failure in the source's words: "Couldn't connect: password
 * authentication failed for user "postgres"". Network errors are named in
 * plain words, and Supabase's IPv6-only direct host gets the pooler hint.
 */
export function describeSourceError(
  err: unknown,
  ctx: { host: string; port: number; family?: 4 | 6; secrets: readonly string[] },
): string {
  // The limits on what a source sends say themselves (lib/import/source-guard.ts).
  if (err instanceof SourceWireError) return err.message
  const e = err as { code?: string; message?: string } | null
  const code = e?.code ?? ''
  const where = `${ctx.host}:${ctx.port}`
  const supabaseDirect = /^db\.[a-z0-9]+\.supabase\.co$/i.test(ctx.host)
  const ipv6Hint = supabaseDirect
    ? " Supabase's direct host answers over IPv6 only; use the Session pooler connection string (Connect → Session pooler, port 5432) instead."
    : ''
  switch (code) {
    case 'ECONNREFUSED':
      return `Couldn't connect: ${where} refused the connection. Check the host and port, and that the database accepts connections from the internet.`
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      return `Couldn't connect: ${where} did not answer within ${Math.round(SOURCE_LIMITS.connectTimeoutMs / 1000)} seconds.${ctx.family === 6 ? ipv6Hint : ''}`
    case 'ENETUNREACH':
    case 'EHOSTUNREACH':
    case 'EADDRNOTAVAIL':
      return `Couldn't connect: ${where} is not reachable from Backenly.${ctx.family === 6 ? ipv6Hint : ''}`
    case 'ECONNRESET':
      return `Couldn't connect: ${where} closed the connection. If it needs an encrypted connection, add ?sslmode=require.`
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'CERT_HAS_EXPIRED':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `Couldn't connect: the server's certificate did not verify (${code}). Use sslmode=require to encrypt without verifying, or give the server a certificate for ${ctx.host}.`
  }
  const message = redactedMessage(e?.message ?? err, ctx.secrets, 300)
  if (/timeout expired|Connection terminated due to connection timeout/i.test(message)) {
    return `Couldn't connect: ${where} did not answer within ${Math.round(SOURCE_LIMITS.connectTimeoutMs / 1000)} seconds.${ctx.family === 6 ? ipv6Hint : ''}`
  }
  return `Couldn't connect: ${message || 'the connection failed'}`
}

// ── Reading ───────────────────────────────────────────────────────────────────

/** What a read step may ask of the source. */
export interface SourceReader {
  query<R = any>(text: string, values?: unknown[]): Promise<{ rows: R[]; fields: Array<{ name: string }> }>
  /** Rows as arrays, in select-list order. */
  queryArrays(text: string, values?: unknown[]): Promise<{ rows: unknown[][]; fields: Array<{ name: string }> }>
}

/**
 * Run `fn` in ONE read-only, repeatable-read transaction on the source: every
 * statement in it sees the same snapshot (tables copied minutes apart still
 * agree with each other, as pg_dump's do), and PostgreSQL itself refuses any
 * write. Settings are LOCAL to the transaction, so a pooled source keeps none
 * of them afterwards.
 */
export async function readSnapshot<T>(
  conn: SourceConnection,
  fn: (reader: SourceReader) => Promise<T>,
  opts: { statementTimeoutMs?: number } = {},
): Promise<T> {
  const client = conn.client
  const timeout = opts.statementTimeoutMs ?? SOURCE_LIMITS.statementTimeoutMs
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  let done = false
  try {
    await client.query(`SET LOCAL statement_timeout = ${Math.max(1000, Math.floor(timeout))}`)
    await client.query(`SET LOCAL lock_timeout = ${SOURCE_LIMITS.lockTimeoutMs}`)
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = 900000`)
    await client.query(`SET LOCAL TIME ZONE 'UTC'`)
    await client.query(`SET LOCAL DateStyle = 'ISO, YMD'`)
    await client.query(`SET LOCAL IntervalStyle = 'postgres'`)
    await client.query(`SET LOCAL extra_float_digits = 3`)
    await client.query(`SET LOCAL bytea_output = 'hex'`)
    const reader: SourceReader = {
      query: async (text, values) => {
        const r = await client.query(text, values as any[])
        return { rows: r.rows, fields: r.fields }
      },
      queryArrays: async (text, values) => {
        const r = await client.query({ text, values: values as any[], rowMode: 'array' })
        return { rows: r.rows as unknown[][], fields: r.fields }
      },
    }
    const out = await fn(reader)
    await client.query('COMMIT')
    done = true
    return out
  } finally {
    if (!done) await client.query('ROLLBACK').catch(() => {})
  }
}

// ── Storage API addresses ────────────────────────────────────────────────────

/**
 * Check a Supabase project URL before a key is ever sent to it.
 *
 * https://<ref>.supabase.co, or a self-hosted Supabase whose host passes the
 * same address checks as a database. Plain http only where private egress is
 * open (a self-hosted Backenly reading a Supabase on its own LAN). Returns the
 * origin, without a trailing slash.
 */
export async function checkProjectUrl(raw: string, opts: { lookup?: Lookup } = {}): Promise<string> {
  const text = typeof raw === 'string' ? raw.trim() : ''
  const field = 'projectUrl' as const
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new ImportInputError('Paste the Project URL, like https://abcd.supabase.co', field)
  }
  if (url.username || url.password) throw new ImportInputError('The Project URL must not carry a user or password.', field)
  const insecureAllowed = privateEgressAllowedFor('import')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && insecureAllowed)) {
    throw new ImportInputError('The Project URL starts with https://', field)
  }
  if (url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new ImportInputError('Paste the Project URL alone, like https://abcd.supabase.co, without a path.', field)
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!/\.supabase\.co$/i.test(host)) {
    // A self-hosted Supabase: allowed when its address is one Backenly may reach.
    await resolveCheckedAddress(host, { field, lookup: opts.lookup })
  }
  return url.origin
}
