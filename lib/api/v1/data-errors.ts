/**
 * What a v1 data request answers when it asked for something its table cannot
 * take: a value its column cannot read, a missing required value, a duplicate
 * of a unique one, a reference to a row that does not exist, a column or a
 * filter that is not there. Those are the caller's to correct, so they answer
 * 400 or 409 with the column and what it expects, the statuses the /db data
 * plane gives the same errors (lib/postgrest/translate.ts). Both servers
 * answered every one of them 500 "Failed to …".
 *
 * Anything else is null: a fault on this side, answered as before.
 */

import { explainDbError, type QueryContext } from '@/lib/db/query-errors'
import { FilterError } from './where'

/** SQLSTATEs that mean the request asked for something its table cannot take. */
const REFUSED: Record<string, 400 | 409> = {
  '22P02': 400, // a value its column's type cannot read
  '22007': 400, // a malformed date or time
  '22008': 400, // a date or time out of range
  '22003': 400, // a number out of the column's range
  '22001': 400, // text longer than the column allows
  '42804': 400, // a value of another type than the column's
  '42703': 400, // no such column
  '23502': 400, // a required column left empty
  '23514': 400, // a value the column's check does not allow
  '23505': 409, // a duplicate of a unique value
  '23503': 409, // a reference to a row that does not exist
}

export interface DataRequestRefusal {
  status: 400 | 409
  code: 'VALIDATION_ERROR' | 'CONFLICT'
  message: string
  details?: { column?: string; expected?: string; example?: string }
}

/**
 * @param context what was bound (TypedParams.context), so a refusal can name
 *                the column PostgreSQL left out.
 */
export function refusedDataRequest(error: unknown, context?: QueryContext): DataRequestRefusal | null {
  if (error instanceof FilterError) {
    return {
      status: 400,
      code: 'VALIDATION_ERROR',
      message: error.message,
      ...(error.column ? { details: { column: error.column } } : {}),
    }
  }

  const { structured } = explainDbError(error, context)
  const status = REFUSED[structured.code]
  if (!status) return null

  const details: DataRequestRefusal['details'] = {}
  if (structured.column) details.column = structured.column
  if (structured.expected) details.expected = structured.expected
  if (structured.example) details.example = structured.example
  return {
    status,
    code: status === 409 ? 'CONFLICT' : 'VALIDATION_ERROR',
    message: structured.message,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  }
}
