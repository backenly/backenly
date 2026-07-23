/**
 * CHAT APP BLUEPRINT
 * ==================
 * Full backend for any chat/messaging app (Slack / Discord / WhatsApp /
 * Telegram). DMs, group rooms, reactions, attachments, presence, typing
 * indicators, read receipts, contacts, blocks.
 *
 * Tables (11): users, conversations, conversation_participants, messages,
 *   reactions, attachments, presence, typing_indicators, contacts, blocks,
 *   read_receipts
 * Storage: chat-media bucket (private, signed-URL access)
 * Realtime: messages, reactions, presence, typing_indicators, read_receipts
 * Triggers: notify on new message
 */

import type { Blueprint, BlueprintColumn } from './types'

const col = (n: string, t: BlueprintColumn['type'], o: Partial<BlueprintColumn> = {}): BlueprintColumn => ({ name: n, type: t, ...o })
const createTable = (label: string, tableName: string, columns: BlueprintColumn[]) => ({ label, tool: 'create_table', args: { tableName, columns } })
const generateApi = (tableName: string) => ({ label: `Generate REST API for ${tableName}`, tool: 'generate_api', args: { tableName } })
const addRls = (tableName: string, policy: string, label?: string) => ({ label: label ?? `Lock down ${tableName} with ${policy} RLS`, tool: 'add_rls', args: { tableName, policy } })
const enableRealtime = (tableName: string) => ({ label: `Stream realtime changes on ${tableName}`, tool: 'enable_realtime', args: { tableName } })
const createTrigger = (tableName: string, on: 'insert' | 'update' | 'delete') => ({ label: `Add ${on} trigger on ${tableName}`, tool: 'create_trigger', args: { tableName, on, kind: 'notify' } })

export const CHAT_APP_BLUEPRINT: Blueprint = {
  domain: 'chat-app',
  title: 'Chat App Backend',
  summary:
    '11 tables (conversations, participants, messages, reactions, attachments, ' +
    'presence, typing, contacts, blocks, read_receipts), chat media storage, ' +
    'realtime on every live surface, notify-on-message triggers.',
  steps: [
    { label: 'Enable end-user authentication (email + password)', tool: 'enable_auth', args: {} },

    createTable('Create conversations (DM + group rooms)', 'conversations', [
      col('created_by', 'uuid'),
      col('is_group', 'boolean'),
      col('title', 'text', { nullable: true }),
      col('topic', 'text', { nullable: true }),
      col('icon_url', 'text', { nullable: true }),
      col('last_message_at', 'timestamp', { nullable: true }),
    ]),

    createTable('Create conversation_participants', 'conversation_participants', [
      col('conversation_id', 'uuid', { fkTo: 'conversations' }),
      col('user_id', 'uuid'),
      col('role', 'text', { nullable: true }),     // admin | member
      col('joined_at', 'timestamp', { nullable: true }),
      col('last_read_at', 'timestamp', { nullable: true }),
      col('muted', 'boolean', { nullable: true }),
    ]),

    createTable('Create messages (threaded via parent_message_id)', 'messages', [
      col('conversation_id', 'uuid', { fkTo: 'conversations' }),
      col('sender_id', 'uuid'),
      col('content', 'text'),
      col('message_type', 'text'),                 // text | image | video | file | system
      col('parent_message_id', 'uuid', { fkTo: 'messages', nullable: true }),
      col('edited_at', 'timestamp', { nullable: true }),
      col('deleted_at', 'timestamp', { nullable: true }),
    ]),

    createTable('Create reactions (emoji on a message)', 'reactions', [
      col('message_id', 'uuid', { fkTo: 'messages' }),
      col('user_id', 'uuid'),
      col('emoji', 'text'),
    ]),

    createTable('Create attachments (files on a message)', 'attachments', [
      col('message_id', 'uuid', { fkTo: 'messages' }),
      col('url', 'text'),
      col('filename', 'text', { nullable: true }),
      col('mime_type', 'text', { nullable: true }),
      col('size_bytes', 'bigint', { nullable: true }),
      col('thumbnail_url', 'text', { nullable: true }),
    ]),

    createTable('Create presence (online + status)', 'presence', [
      col('user_id', 'uuid', { unique: true }),
      col('status', 'text'),                       // online | away | busy | offline
      col('last_seen_at', 'timestamp', { nullable: true }),
      col('status_message', 'text', { nullable: true }),
    ]),

    createTable('Create typing_indicators (transient)', 'typing_indicators', [
      col('conversation_id', 'uuid', { fkTo: 'conversations' }),
      col('user_id', 'uuid'),
      col('started_at', 'timestamp', { nullable: true }),
    ]),

    createTable('Create contacts (address book)', 'contacts', [
      col('user_id', 'uuid'),
      col('contact_user_id', 'uuid'),
      col('display_name', 'text', { nullable: true }),
      col('favorite', 'boolean', { nullable: true }),
    ]),

    createTable('Create blocks (user blocks another user)', 'blocks', [
      col('user_id', 'uuid'),
      col('blocked_user_id', 'uuid'),
    ]),

    createTable('Create read_receipts', 'read_receipts', [
      col('message_id', 'uuid', { fkTo: 'messages' }),
      col('user_id', 'uuid'),
      col('read_at', 'timestamp'),
    ]),

    generateApi('conversations'),
    generateApi('conversation_participants'),
    generateApi('messages'),
    generateApi('reactions'),
    generateApi('attachments'),
    generateApi('presence'),
    generateApi('typing_indicators'),
    generateApi('contacts'),
    generateApi('blocks'),
    generateApi('read_receipts'),

    addRls('conversations', 'owner_read_write'),
    addRls('conversation_participants', 'owner_read_write'),
    addRls('messages', 'owner_read_write'),
    addRls('reactions', 'owner_read_write'),
    addRls('attachments', 'owner_read_write'),
    addRls('presence', 'public_read', 'Presence is public-read (so contacts can see status)'),
    addRls('typing_indicators', 'owner_read_write'),
    addRls('contacts', 'owner_read_write'),
    addRls('blocks', 'owner_read_write'),
    addRls('read_receipts', 'owner_read_write'),

    enableRealtime('messages'),
    enableRealtime('reactions'),
    enableRealtime('presence'),
    enableRealtime('typing_indicators'),
    enableRealtime('read_receipts'),
    enableRealtime('conversations'),
    enableRealtime('conversation_participants'),

    createTrigger('messages', 'insert'),
    createTrigger('reactions', 'insert'),

    {
      label: 'Create chat-media bucket (private, signed-url access)',
      tool: 'create_bucket',
      args: { bucketName: 'chat-media', isPublic: false },
    },
  ],
  warnings: [
    'Owner-only RLS on conversations means only the creator sees them by default. Switch a few tables to public_read once you wire seat-based participant checks.',
    'typing_indicators is a real table for SDK reuse; for true ephemerality use the broadcast channel.',
  ],
}
