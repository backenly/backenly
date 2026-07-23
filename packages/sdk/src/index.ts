import { BackenlyClient } from './client'

export { BackenlyClient } from './client'
export { AuthModule } from './auth'
export { QueryBuilder, TableClient } from './database'
export { StorageModule } from './storage'

// Realtime
export { RealtimeModule } from './realtime'
export type {
  RealtimeEvent,
  DBChangeEvent,
  ConnectedEvent,
  StreamErrorEvent,
  BroadcastEvent,
  RealtimeCallback,
  BroadcastCallback,
  Unsubscribe,
} from './realtime'

// Presence
export { PresenceModule } from './presence'
export type { PresenceUser, PresenceEvent, PresenceCallback } from './presence'

export { BackenlyError } from './errors'
export * from './types'

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
export { createTypedClient } from './typed'
export type { TypedClient, Row, Insert, Update } from './typed'

// ── supabase-js compatibility shim (migration bridge) ────────────────────────
export {
  createClient as createSupabaseCompatClient,
  BackenlySupabaseCompat,
  CompatQueryBuilder,
} from './supabase-compat'
