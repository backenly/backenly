/**
 * What makes the production path production, and what makes it read-only.
 *
 * These are pure so they can be tested without a database, and they refuse
 * rather than warn. The staging probe's guards are the mirror image of these and
 * are deliberately NOT reused: a guard that can be pointed at either environment
 * by changing an argument is one typo away from being pointed at the wrong one.
 */

export class ProductionGuardRefusal extends Error {}

const refuse = (message: string): never => {
  throw new ProductionGuardRefusal(message)
}

/**
 * The URL must name production and must not name staging.
 *
 * Never echoed: it carries a password.
 */
export function assertProductionUrl(url: string): void {
  if (!/production/i.test(url)) refuse('database URL does not identify production')
  if (/staging/i.test(url)) refuse('database URL names staging; this probe reads production only')
}

export function assertRdsEndpoint(host: string): void {
  if (!/\.rds\.amazonaws\.com$/i.test(host)) refuse('database host is not an RDS endpoint')
}

/**
 * The operator states which database they expect, and the server is asked what
 * it actually is. A capture of the wrong database would otherwise look like a
 * successful capture of the right one.
 */
export function assertExpectedDatabase(expected: string | undefined, actual: string): void {
  const wanted = expected?.trim()
  if (!wanted) {
    refuse('PRODUCTION_DB_NAME is not set; state the database this capture is allowed to read')
  }
  if (wanted !== actual) refuse(`connected to database ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`)
}

/** Read-only is a property of the session, asserted from the server's own answer. */
export function assertReadOnlySession(transactionReadOnly: string | undefined): void {
  if (transactionReadOnly !== 'on') {
    refuse(`session is not read-only (transaction_read_only = ${String(transactionReadOnly)})`)
  }
}
