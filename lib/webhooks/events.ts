/**
 * THE EVENT VOCABULARY, IN ONE PLACE
 * ==================================
 *
 * There were two lists before this file, and they disagreed.
 *
 *   lib/webhooks/index.ts   'row.inserted' | 'row.updated' | 'row.deleted' | 'auth.user.created'
 *   app/api/.../webhooks    ['row.inserted', 'row.deleted', 'auth.user.created']
 *
 * So `row.updated` was a supported event everywhere except the only route that
 * could create one. The type said yes, the validator said no, and nothing
 * compared them — a UI built from the type would have offered an option the
 * API rejects at runtime.
 *
 * Every surface now reads this module: the create/edit routes validate against
 * it, the capture layer maps it to Postgres operations, and the picker in the
 * dashboard is rendered from it. Adding an event is one edit and the surfaces
 * cannot drift apart again.
 */

/** Events produced by a row change in the project's workspace schema. */
export const ROW_EVENT_TYPES = ['row.inserted', 'row.updated', 'row.deleted'] as const

/**
 * Events produced by the platform rather than by a table write.
 *
 * `auth.user.created` is here and not in ROW_EVENT_TYPES on purpose. Signups
 * write to the project's `users` table, but that table is auth-managed and
 * deliberately carries no capture trigger: it holds the bcrypt hash, and
 * realtime spent months broadcasting exactly that before it was caught. This
 * event is emitted by the signup route from a payload built field by field.
 */
export const PLATFORM_EVENT_TYPES = ['auth.user.created'] as const

export const WEBHOOK_EVENT_TYPES = [...ROW_EVENT_TYPES, ...PLATFORM_EVENT_TYPES] as const

export type RowEventType = (typeof ROW_EVENT_TYPES)[number]
export type PlatformEventType = (typeof PLATFORM_EVENT_TYPES)[number]
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number]

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return typeof value === 'string' && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value)
}

export function isRowEventType(value: unknown): value is RowEventType {
  return typeof value === 'string' && (ROW_EVENT_TYPES as readonly string[]).includes(value)
}

/** What the dashboard shows beside each option. */
export const EVENT_DESCRIPTIONS: Record<WebhookEventType, string> = {
  'row.inserted': 'A row was inserted into any table in this project.',
  'row.updated': 'A row was updated. The payload carries both the new and previous values.',
  'row.deleted': 'A row was deleted. The payload carries the row as it was.',
  'auth.user.created': 'An end user signed up. Never includes credentials.',
}
