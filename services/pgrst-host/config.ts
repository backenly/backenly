/**
 * The PostgREST host's configuration, read once from its environment.
 *
 * Every setting is named PGRST_HOST_*, apart from the names PostgREST itself
 * reads (PGRST_DB_URI, PGRST_JWT_SECRET, ...): a child's environment is built
 * from scratch (launcher.ts), so nothing set on the host reaches a child by
 * accident, and nothing meant for a child configures the host.
 *
 * A value that is set but invalid stops the host at startup with the
 * variable's name. Secret values are never printed.
 */

import { PROJECT_DATABASE_NAME } from './token'

export interface HostConfig {
  /** Where the host listens. Children always bind 127.0.0.1. */
  listenHost: string
  port: number
  /** The region's PostgREST JWT secret: verifies tokens here and in every child. */
  jwtSecret: string
  /** The authenticator's connection URI; each child gets it with its own database. */
  dbUri: string
  /** The postgrest executable. */
  binary: string
  /** Hard cap on running children. */
  maxChildren: number
  /** PGRST_DB_POOL of each child. */
  childDbPool: number
  /** PGRST_DB_POOL_MAX_IDLETIME of each child, in seconds. */
  childPoolIdleSeconds: number
  /** A child with no proxied request for this long is stopped. */
  idleMs: number
  /** How long a new child has to answer its admin /ready. */
  readyTimeoutMs: number
  /** Between SIGTERM and SIGKILL when a child is stopped. */
  stopGraceMs: number
  /** Largest request body forwarded, as the runtime caps its own (express.json 10mb). */
  maxBodyBytes: number
  /** A proxied request whose child is silent this long answers 504. */
  upstreamTimeoutMs: number
  /** This many failures of one database within crashWindowMs open its circuit. */
  crashLimit: number
  crashWindowMs: number
  /** How long an open circuit refuses to start the database's child. */
  circuitOpenMs: number
  /** Retry-After on a 503 DATA_PLANE_BUSY. */
  busyRetryAfterSeconds: number
}

export const DEFAULTS = {
  listenHost: '0.0.0.0',
  port: 3200,
  binary: 'postgrest',
  maxChildren: 20,
  childDbPool: 3,
  childPoolIdleSeconds: 30,
  idleSeconds: 600,
  readyTimeoutSeconds: 10,
  stopGraceSeconds: 10,
  maxBodyBytes: 10 * 1024 * 1024,
  upstreamTimeoutSeconds: 60,
  crashLimit: 3,
  crashWindowMs: 5 * 60 * 1000,
  circuitOpenMs: 5 * 60 * 1000,
  busyRetryAfterSeconds: 5,
} as const

/** PostgREST refuses a JWT secret shorter than this. */
export const MIN_SECRET_LENGTH = 32

type Env = Readonly<Record<string, string | undefined>>

function setting(env: Env, name: string): string | undefined {
  const value = env[name]
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined
}

function number(env: Env, name: string, fallback: number, min: number, max: number, integer = true): number {
  const raw = setting(env, name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}.`)
  }
  return value
}

/** The authenticator URI, checked to be one a child can be given with its database replaced. */
function authenticatorUri(env: Env): string {
  const name = 'PGRST_HOST_DB_URI'
  const raw = setting(env, name)
  if (!raw) throw new Error(`${name} is not set.`)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    // The value is a credential: the message names the variable, never the value.
    throw new Error(`${name} is not a single-host postgres:// or postgresql:// URI.`)
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${name} must be a postgres:// or postgresql:// URI.`)
  }
  if (!url.hostname || !url.username) throw new Error(`${name} must name a host and a user.`)
  return raw
}

export function readConfig(env: Env = process.env): HostConfig {
  const jwtSecret = env.PGRST_HOST_JWT_SECRET ?? ''
  if (!jwtSecret.trim()) throw new Error('PGRST_HOST_JWT_SECRET is not set.')
  if (jwtSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(`PGRST_HOST_JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters, as PostgREST requires.`)
  }

  return {
    listenHost: setting(env, 'PGRST_HOST_BIND') ?? DEFAULTS.listenHost,
    port: number(env, 'PGRST_HOST_PORT', DEFAULTS.port, 1, 65535),
    jwtSecret,
    dbUri: authenticatorUri(env),
    binary: setting(env, 'PGRST_HOST_BINARY') ?? DEFAULTS.binary,
    maxChildren: number(env, 'PGRST_HOST_MAX_CHILDREN', DEFAULTS.maxChildren, 1, 1000),
    childDbPool: number(env, 'PGRST_HOST_CHILD_DB_POOL', DEFAULTS.childDbPool, 1, 10),
    childPoolIdleSeconds: DEFAULTS.childPoolIdleSeconds,
    idleMs: number(env, 'PGRST_HOST_IDLE_SECONDS', DEFAULTS.idleSeconds, 1, 86_400, false) * 1000,
    readyTimeoutMs: number(env, 'PGRST_HOST_READY_TIMEOUT_SECONDS', DEFAULTS.readyTimeoutSeconds, 0.1, 300, false) * 1000,
    stopGraceMs: number(env, 'PGRST_HOST_STOP_GRACE_SECONDS', DEFAULTS.stopGraceSeconds, 0, 300, false) * 1000,
    maxBodyBytes: number(env, 'PGRST_HOST_MAX_BODY_BYTES', DEFAULTS.maxBodyBytes, 1, 1024 * 1024 * 1024),
    upstreamTimeoutMs:
      number(env, 'PGRST_HOST_UPSTREAM_TIMEOUT_SECONDS', DEFAULTS.upstreamTimeoutSeconds, 1, 3600, false) * 1000,
    crashLimit: DEFAULTS.crashLimit,
    crashWindowMs: DEFAULTS.crashWindowMs,
    circuitOpenMs: DEFAULTS.circuitOpenMs,
    busyRetryAfterSeconds: DEFAULTS.busyRetryAfterSeconds,
  }
}

/**
 * The authenticator URI pointed at one project database. Only the path
 * changes: host, user, password and parameters (sslmode, ...) are the
 * authenticator's own.
 */
export function databaseUri(baseUri: string, database: string): string {
  if (!PROJECT_DATABASE_NAME.test(database)) {
    throw new Error(`Refusing to connect a child to "${database}": not a project database name.`)
  }
  const url = new URL(baseUri)
  url.pathname = `/${database}`
  return url.toString()
}
