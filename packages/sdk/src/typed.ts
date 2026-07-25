/**
 * TYPED CLIENT FACTORY
 * ====================
 * Generic factory that lets the *generated* backenly.client.ts apply
 * compile-time types to the BackenlyClient proxy without any runtime cost.
 *
 * Usage in generated code:
 *
 *   import { createTypedClient } from '@backenly/sdk'
 *   import type { Database } from './backenly.types'
 *
 *   export const backend = createTypedClient<Database>({ projectId: 'abc' })
 *   // backend.posts → TableClient<PostsRow>
 *   // backend.users → TableClient<UsersRow>
 *
 * The generic TSchema must be a Record whose values have a `Row` key:
 *
 *   type MyDB = {
 *     posts: { Row: PostsRow; Insert: PostsInsert; Update: PostsUpdate }
 *     users: { Row: UsersRow; Insert: UsersInsert; Update: UsersUpdate }
 *   }
 */

import { BackenlyClient } from './client.js'
import type { TableClient } from './database.js'

// ── Type helpers ──────────────────────────────────────────────────────────────

/** Extract Row shape for a table from a Database type */
export type Row<
  TDatabase extends Record<string, { Row: any }>,
  TTable extends keyof TDatabase,
> = TDatabase[TTable]['Row']

/** Extract Insert shape for a table from a Database type */
export type Insert<
  TDatabase extends Record<string, { Insert?: any }>,
  TTable extends keyof TDatabase,
> = TDatabase[TTable] extends { Insert: any } ? TDatabase[TTable]['Insert'] : Record<string, unknown>

/** Extract Update shape for a table from a Database type */
export type Update<
  TDatabase extends Record<string, { Update?: any }>,
  TTable extends keyof TDatabase,
> = TDatabase[TTable] extends { Update: any } ? TDatabase[TTable]['Update'] : Record<string, unknown>

// ── Typed client shape ────────────────────────────────────────────────────────

/**
 * Merges BackenlyClient with typed table accessors derived from TDatabase.
 *
 * Every key of TDatabase becomes a `TableClient<Row>` property on the client.
 * Non-table properties (auth, storage, realtime, etc.) retain their original types.
 */
export type TypedClient<TDatabase extends Record<string, { Row: any }>> =
  BackenlyClient & {
    [K in keyof TDatabase]: TableClient<TDatabase[K]['Row']>
  }

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a typed BackenlyClient that carries compile-time types for every
 * table defined in TDatabase.
 *
 * @example
 * import type { Database } from './backenly.types'
 * const backend = createTypedClient<Database>({ projectId: 'my-proj-id' })
 * const posts = await backend.posts.list() // → PostsRow[]
 */
export function createTypedClient<TDatabase extends Record<string, { Row: any }>>(config: {
  projectId: string
  apiUrl?: string
}): TypedClient<TDatabase> {
  return new BackenlyClient(config) as unknown as TypedClient<TDatabase>
}
