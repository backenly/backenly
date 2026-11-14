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
 *   export const backend = createTypedClient<Database>({ projectId: 'abc', apiKey: 'proj_live_…' })
 *   // backend.posts → TableClient<PostsRow>
 *   // backend.users → TableClient<UsersRow>
 *
 * The Database type maps each table to its `Row` (and, optionally, its
 * `Insert` and `Update`), as `npx @backenly/cli types` writes it:
 *
 *   interface Database {
 *     posts: { Row: PostsRow; Insert: PostsInsert; Update: PostsUpdate }
 *     users: { Row: UsersRow; Insert: UsersInsert; Update: UsersUpdate }
 *   }
 *
 * The constraints below are mapped over the type's own keys rather than
 * written as `Record<string, …>`: the CLI writes `Database` as an interface,
 * and an interface has no index signature, so a Record constraint refused the
 * very type the CLI generates.
 */

import { BackenlyClient } from './client.js'
import type { TableClient } from './database.js'
import type { BackenlyConfig } from './types.js'

// ── Type helpers ──────────────────────────────────────────────────────────────

/** Extract Row shape for a table from a Database type */
export type Row<
  TDatabase extends { [K in keyof TDatabase]: { Row: any } },
  TTable extends keyof TDatabase,
> = TDatabase[TTable]['Row']

/** Extract Insert shape for a table from a Database type */
export type Insert<
  TDatabase extends { [K in keyof TDatabase]: { Insert?: any } },
  TTable extends keyof TDatabase,
> = TDatabase[TTable] extends { Insert: any } ? TDatabase[TTable]['Insert'] : Record<string, unknown>

/** Extract Update shape for a table from a Database type */
export type Update<
  TDatabase extends { [K in keyof TDatabase]: { Update?: any } },
  TTable extends keyof TDatabase,
> = TDatabase[TTable] extends { Update: any } ? TDatabase[TTable]['Update'] : Record<string, unknown>

// ── Typed client shape ────────────────────────────────────────────────────────

/**
 * Merges BackenlyClient with typed table accessors derived from TDatabase.
 *
 * Every key of TDatabase becomes a `TableClient<Row>` property on the client.
 * Non-table properties (auth, storage, realtime, etc.) retain their original types.
 */
export type TypedClient<TDatabase extends { [K in keyof TDatabase]: { Row: any } }> =
  BackenlyClient & {
    [K in keyof TDatabase]: TableClient<TDatabase[K]['Row']>
  }

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a typed BackenlyClient that carries compile-time types for every
 * table defined in TDatabase.
 *
 * Takes the same configuration as createClient, `apiKey` included.
 *
 * @example
 * import type { Database } from './backenly.types'
 * const backend = createTypedClient<Database>({ projectId: 'my-proj-id', apiKey: 'proj_live_…' })
 * const posts = await backend.posts.list() // → PostsRow[]
 */
export function createTypedClient<TDatabase extends { [K in keyof TDatabase]: { Row: any } }>(
  config: BackenlyConfig,
): TypedClient<TDatabase> {
  return new BackenlyClient(config) as unknown as TypedClient<TDatabase>
}
