/**
 * Database connections for the lineage probe, with TLS that is actually verified.
 *
 * Two facts from the staging smoke test shape this file:
 *
 *   • pg is stricter than Prisma about the RDS chain, and answers
 *     SELF_SIGNED_CERT_IN_CHAIN without the RDS certificate authorities.
 *   • pg-connection-string turns `sslmode`, `sslrootcert` and friends in a URL
 *     into its own ssl settings, and `sslmode=require` with no root CA becomes
 *     `rejectUnauthorized: false`. A URL parameter can silently undo explicit
 *     configuration.
 *
 * So a URL is never handed to pg. It is parsed into discrete fields here, its
 * query parameters are discarded and reported, and TLS is configured in exactly
 * one place with `rejectUnauthorized: true`. There is no code path that turns
 * verification off; the only plaintext mode refuses any non-loopback host.
 */

import * as tls from 'node:tls'
import type { Client as PgClient, ClientConfig } from 'pg'

// pg/lib/client rather than pg: the package index also loads the pool and the
// native-binding lookup, which this probe never uses and which cost bytes in a
// task definition capped at 64 KB.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Client: typeof PgClient = require('pg/lib/client')

export type { PgClient }

export interface DbTarget {
  host: string
  port: number
  user: string
  password: string
  database: string
}

export function parseDatabaseUrl(url: string): { target: DbTarget; ignoredParameters: string[] } {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    // Never echo the input: it carries a password.
    throw new Error('database URL could not be parsed')
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new Error(`unsupported database URL protocol ${u.protocol}`)
  }
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''))
  if (!u.hostname || !database) throw new Error('database URL must name a host and a database')
  return {
    target: {
      host: u.hostname,
      port: u.port ? Number(u.port) : 5432,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database,
    },
    ignoredParameters: [...new Set(u.searchParams.keys())].sort(),
  }
}

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

export type TlsPolicy = { mode: 'verify-full'; ca: string } | { mode: 'loopback-plaintext' }

export interface ConnectOverrides {
  database?: string
  /**
   * Verify the certificate as though it had been presented for this name.
   * Exists only for the negative control that proves identity is checked.
   */
  identityCheckAs?: string
}

export function clientConfig(target: DbTarget, policy: TlsPolicy, overrides: ConnectOverrides = {}): ClientConfig {
  const base: ClientConfig = {
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: overrides.database ?? target.database,
    application_name: 'backenly-migration-lineage',
    connectionTimeoutMillis: 20_000,
  }

  if (policy.mode === 'loopback-plaintext') {
    if (!isLoopback(target.host)) throw new Error('plaintext connections are only allowed to a loopback host')
    return { ...base, ssl: false }
  }

  if (!policy.ca.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error('verify-full requires a certificate authority bundle')
  }
  const ssl: tls.ConnectionOptions = { ca: policy.ca, rejectUnauthorized: true }
  if (overrides.identityCheckAs) {
    const as = overrides.identityCheckAs
    ssl.checkServerIdentity = (_host, cert) => tls.checkServerIdentity(as, cert)
  }
  return { ...base, ssl }
}

export async function connect(config: ClientConfig): Promise<PgClient> {
  const client = new Client(config)
  // An error event after connect would otherwise crash the task with no result.
  client.on('error', () => {})
  await client.connect()
  return client
}

export interface TlsObservation {
  authorized: boolean
  authorizationError: string | null
  protocol: string | null
  chain: Array<{ subject: string; issuer: string; validTo: string }>
  server: { ssl: boolean; version: string | null; cipher: string | null }
}

/** What the client verified, and what the server says about the same session. */
export async function observeTls(client: PgClient): Promise<TlsObservation> {
  const stream = (client as unknown as { connection?: { stream?: tls.TLSSocket } }).connection?.stream
  if (!stream || typeof stream.getPeerCertificate !== 'function') {
    throw new Error('connection is not using TLS')
  }

  const chain: TlsObservation['chain'] = []
  const seen = new Set<string>()
  let cert: tls.DetailedPeerCertificate | undefined = stream.getPeerCertificate(true)
  while (cert && cert.fingerprint256 && !seen.has(cert.fingerprint256)) {
    seen.add(cert.fingerprint256)
    chain.push({ subject: String(cert.subject?.CN ?? ''), issuer: String(cert.issuer?.CN ?? ''), validTo: cert.valid_to })
    cert = cert.issuerCertificate
  }

  const { rows } = await client.query(
    'SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()',
  )
  return {
    authorized: stream.authorized,
    authorizationError: stream.authorizationError ? String(stream.authorizationError) : null,
    protocol: stream.getProtocol(),
    chain,
    server: { ssl: rows[0]?.ssl === true, version: rows[0]?.version ?? null, cipher: rows[0]?.cipher ?? null },
  }
}

const VERIFICATION_ERRORS = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_UNTRUSTED',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

export interface TlsControl {
  label: string
  /** True only when the connection was refused BY CERTIFICATE VERIFICATION. */
  refusedByVerification: boolean
  code: string | null
  message: string
}

/**
 * A connection that must fail certificate verification.
 *
 * A control that fails for another reason (a timeout, a refused socket) proves
 * nothing about verification, so it is reported as not refused rather than
 * counted as a pass. Verification fails during the handshake, before pg sends
 * the startup message, so no password reaches an unverified peer.
 */
export async function expectVerificationRefusal(label: string, config: ClientConfig): Promise<TlsControl> {
  let client: PgClient | null = null
  try {
    client = await connect(config)
    return { label, refusedByVerification: false, code: null, message: 'connection succeeded' }
  } catch (err) {
    const code = (err as { code?: string }).code ?? null
    const message = err instanceof Error ? err.message : String(err)
    return { label, refusedByVerification: code !== null && VERIFICATION_ERRORS.has(code), code, message }
  } finally {
    await client?.end().catch(() => {})
  }
}

export function publicRootsOnly(): string {
  return tls.rootCertificates.join('\n')
}
