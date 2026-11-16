/**
 * Request bodies for /api/import, checked before anything is read or created.
 *
 * Errors come back as `{ error, field? }`, the field named the way the console's
 * form names it (contract.ts ImportConnection), so the message lands under the
 * right input. Pure: tested in __tests__/import/validation.test.ts.
 */

import { z } from 'zod'
import type { ImportInspectRequest, ImportStartRequest } from './contract'

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/

const connectionString = z
  .string({ required_error: 'Paste the connection string.', invalid_type_error: 'Paste the connection string.' })
  .trim()
  .min(1, 'Paste the connection string.')
  .max(4096, 'That connection string is too long.')

const optionalText = (max: number, tooLong: string) =>
  z
    .string()
    .trim()
    .max(max, tooLong)
    .optional()
    .transform((v) => (v ? v : undefined))

export const connectionSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('supabase'),
    connectionString,
    projectUrl: optionalText(2048, 'That Project URL is too long.'),
    serviceRoleKey: optionalText(8192, 'That key is too long.'),
  }),
  z.object({
    source: z.literal('firebase'),
    serviceAccountJson: z
      .string({ required_error: 'Paste or upload the service account key.', invalid_type_error: 'Paste or upload the service account key.' })
      .trim()
      .min(1, 'Paste or upload the service account key.')
      .max(64 * 1024, 'That file is too large to be a service account key.'),
  }),
  z.object({
    source: z.literal('postgres'),
    connectionString,
    schemas: z
      .array(z.string().trim().regex(IDENT, 'A schema name is letters, digits and underscores.'))
      .max(20, 'Move up to 20 schemas at once.')
      .optional(),
  }),
])

const orgId = z.string({ required_error: 'Choose an organization.' }).uuid('Choose an organization.')

/** The top-level `source` the spec's body carries is optional, but must agree with the connection's. */
const source = z.enum(['supabase', 'firebase', 'postgres']).optional()

export const inspectSchema = z
  .object({ orgId, source, connection: connectionSchema })
  .refine((b) => !b.source || b.source === b.connection.source, { message: 'The source and the connection do not match.', path: ['source'] })

export const startSchema = z
  .object({
    orgId,
    source,
    connection: connectionSchema,
    name: z.string({ required_error: 'Name the new project.' }).trim().min(1, 'Name the new project.').max(100, 'Keep the name under 100 characters.'),
    region: z.string({ required_error: 'Choose a region.' }).trim().min(1, 'Choose a region.').max(32, 'Choose a region.'),
    include: z
      .object({ users: z.boolean().default(true), files: z.boolean().default(true) })
      .default({ users: true, files: true }),
  })
  .refine((b) => !b.source || b.source === b.connection.source, { message: 'The source and the connection do not match.', path: ['source'] })

export type ValidationFailure = { ok: false; error: string; field?: string }

/** The form field an issue belongs under, in the console's names. */
function fieldOf(path: (string | number)[]): string | undefined {
  const last = path[path.length - 1]
  const known = ['connectionString', 'projectUrl', 'serviceRoleKey', 'serviceAccountJson', 'name', 'region', 'schemas']
  for (let i = path.length - 1; i >= 0; i--) {
    if (typeof path[i] === 'string' && known.includes(path[i] as string)) return path[i] as string
  }
  if (path[0] === 'connection' && last === 'source') return undefined
  return undefined
}

function failure(err: z.ZodError): ValidationFailure {
  const issue = err.issues[0]
  if (!issue) return { ok: false, error: 'Check the form.' }
  if (issue.code === 'invalid_union_discriminator') return { ok: false, error: 'Choose Supabase, Firebase or Postgres.' }
  const field = fieldOf(issue.path)
  return { ok: false, error: issue.message, ...(field ? { field } : {}) }
}

export function parseInspect(body: unknown): { ok: true; value: ImportInspectRequest } | ValidationFailure {
  const r = inspectSchema.safeParse(body)
  if (!r.success) return failure(r.error)
  return { ok: true, value: { orgId: r.data.orgId, connection: r.data.connection as ImportInspectRequest['connection'] } }
}

export function parseStart(body: unknown): { ok: true; value: ImportStartRequest } | ValidationFailure {
  const r = startSchema.safeParse(body)
  if (!r.success) return failure(r.error)
  const d = r.data
  return {
    ok: true,
    value: {
      orgId: d.orgId,
      connection: d.connection as ImportStartRequest['connection'],
      name: d.name,
      region: d.region,
      include: { users: d.include.users, files: d.include.files },
    },
  }
}
