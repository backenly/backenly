import { BackenlyClient } from './client.js'

export { BackenlyClient } from './client.js'
export { AuthModule } from './auth.js'
export { QueryBuilder, TableClient } from './database.js'
export { StorageModule } from './storage.js'

// Realtime
export { RealtimeModule } from './realtime.js'
export type {
  RealtimeEvent,
  DBChangeEvent,
  ConnectedEvent,
  StreamErrorEvent,
  BroadcastEvent,
  RealtimeCallback,
  BroadcastCallback,
  Unsubscribe,
} from './realtime.js'

// Presence
export { PresenceModule } from './presence.js'
export type { PresenceUser, PresenceEvent, PresenceCallback } from './presence.js'

export { BackenlyError } from './errors.js'
export * from './types.js'

/**
 * Create a Backenly client.
 *
 *   const backend = createClient({ projectId: "...", apiKey: "proj_live_..." })
 *
 * `apiKey` is optional in the browser: when omitted, the SDK auto-fetches the
 * project's public anon key via the bootstrap handshake
 * (GET /api/v1/{projectId}/bootstrap) before the first authenticated request.
 * Pass it explicitly in Node/SSR or when you want to pin a specific key.
 */
export function createClient(config: { projectId: string; apiUrl?: string; apiKey?: string }) {
  return new BackenlyClient(config)
}

// ── Typed client (for generated backenly.client.ts files) ────────────────────
export { createTypedClient } from './typed.js'
export type { TypedClient, Row, Insert, Update } from './typed.js'

// ── supabase-js compatibility shim (migration bridge) ────────────────────────
export {
  createClient as createSupabaseCompatClient,
  BackenlySupabaseCompat,
  CompatQueryBuilder,
} from './supabase-compat.js'
