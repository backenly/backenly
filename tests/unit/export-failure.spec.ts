/**
 * The plain cause of a failed pg_dump run (lib/services/export-failure.ts),
 * for the ways libpq and the server word each one. The route that uses it is
 * proven in tests/integration/export-says-why-it-failed.spec.ts.
 */

import { exportFailure } from '@/lib/services/export-failure'

describe('a connection that never carried a query', () => {
  it.each([
    'pg_dump: error: connection to server at "db.internal.example" (10.0.0.5), port 5432 failed: could not open certificate file "/root/.postgresql/postgresql.crt": Permission denied',
    'pg_dump: error: connection to server at "db.internal.example" (10.0.0.5), port 5432 failed: FATAL:  no pg_hba.conf entry for host "10.0.0.9", user "backenly_backup", database "backenly", no encryption',
    'pg_dump: error: connection to server at "db.internal.example" (10.0.0.5), port 5432 failed: FATAL:  password authentication failed for user "backenly_backup"',
    'pg_dump: error: connection to server at "db.internal.example" (10.0.0.5), port 5432 failed: timeout expired',
    'pg_dump: [archiver (db)] connection to database "backenly" failed: could not connect to server: Connection refused',
    'pg_dump: error: could not translate host name "db.internal.example" to address: Name or service not known',
  ])('%s', (stderr) => {
    expect(exportFailure(stderr, 1)).toEqual({
      code: 'EXPORT_CONNECTION_FAILED',
      message: "Nothing was exported: pg_dump could not connect to this project's database. Try again in a few minutes.",
    })
  })
})

it('names the object the database refused, quoted as pg_dump quotes it or not', () => {
  expect(exportFailure('pg_dump: error: query failed: ERROR:  permission denied for schema workspace_1', 1).message).toBe(
    'Nothing was exported: the database did not let the export read the schema "workspace_1".',
  )
  expect(exportFailure('pg_dump: error: query failed: ERROR:  permission denied for table "Order Items"', 1).message).toBe(
    'Nothing was exported: the database did not let the export read the table "Order Items".',
  )
  expect(exportFailure('ERROR:  permission denied for sequence orders_id_seq', 1).code).toBe('EXPORT_PERMISSION_DENIED')
})

it('says pg_dump is not there when it could not be started', () => {
  expect(exportFailure('', null)).toEqual({ code: 'EXPORT_UNAVAILABLE', message: 'Nothing was exported: pg_dump is not available on this server.' })
  expect(exportFailure('sh: 1: pg_dump: not found', 127).code).toBe('EXPORT_UNAVAILABLE')
})

it('points at the backup credential when row-level security stops the dump', () => {
  const failure = exportFailure('pg_dump: error: query failed: ERROR:  query would be affected by row-level security policy for table "users"', 1)
  expect(failure.code).toBe('EXPORT_CREDENTIAL')
  expect(failure.message).toContain('BACKUP_DATABASE_URL')
})

it('says nothing was exported for any other error, and never repeats pg_dump', () => {
  const failure = exportFailure('pg_dump: error: query failed: ERROR:  out of shared memory at host 10.0.0.5', 1)
  expect(failure).toEqual({
    code: 'EXPORT_FAILED',
    message: 'Nothing was exported: pg_dump stopped with an error before the dump was complete. Try again in a few minutes.',
  })
})
