/**
 * SOCIAL MEDIA BLUEPRINT
 * ======================
 * The exhaustive backend for any social-media-class app (Instagram /
 * Twitter / TikTok / Threads). Covers the entire surface a real social
 * product needs — not just users + posts + likes.
 *
 * Tables (16): users, profiles, posts, comments, likes, follows,
 *   notifications, conversations, conversation_participants, messages,
 *   hashtags, post_hashtags, bookmarks, blocks, mutes, stories
 * Storage: media bucket (public-readable, owner-writable)
 * Realtime: posts, comments, likes, follows, notifications, messages, stories
 * Triggers: notify on follow, like, comment, mention, message
 */

import type { Blueprint, BlueprintColumn } from './types'

const col = (name: string, type: BlueprintColumn['type'], opts: Partial<BlueprintColumn> = {}): BlueprintColumn => ({ name, type, ...opts })

const createTable = (label: string, tableName: string, columns: BlueprintColumn[]) => ({
  label,
  tool: 'create_table',
  args: { tableName, columns },
})

const generateApi = (tableName: string) => ({
  label: `Generate REST API for ${tableName}`,
  tool: 'generate_api',
  args: { tableName },
})

const addRls = (tableName: string, policy: string, label?: string) => ({
  label: label ?? `Lock down ${tableName} with ${policy} RLS`,
  tool: 'add_rls',
  args: { tableName, policy },
})

const enableRealtime = (tableName: string) => ({
  label: `Stream realtime changes on ${tableName}`,
  tool: 'enable_realtime',
  args: { tableName },
})

const createTrigger = (tableName: string, on: 'insert' | 'update' | 'delete') => ({
  label: `Add ${on} trigger on ${tableName} (in-app notifications)`,
  tool: 'create_trigger',
  args: { tableName, on, kind: 'notify' },
})

export const SOCIAL_MEDIA_BLUEPRINT: Blueprint = {
  domain: 'social-media',
  title: 'Social Media Backend',
  summary:
    '16 tables (users, profiles, posts, comments, likes, follows, notifications, ' +
    'conversations, messages, hashtags, bookmarks, blocks, mutes, stories), media ' +
    'storage, realtime feed + notifications + messages, owner-based RLS across the board.',
  steps: [
    // ── Auth first so RLS templates can reference auth.user_id ──────────────
    { label: 'Enable end-user authentication (email + password)', tool: 'enable_auth', args: {} },

    // ── Core identity ───────────────────────────────────────────────────────
    createTable('Create profiles (display name, bio, avatar, verified, …)', 'profiles', [
      col('user_id', 'uuid', { unique: true }),
      col('username', 'text', { unique: true }),
      col('display_name', 'text'),
      col('bio', 'text', { nullable: true }),
      col('avatar_url', 'text', { nullable: true }),
      col('cover_url', 'text', { nullable: true }),
      col('location', 'text', { nullable: true }),
      col('website', 'text', { nullable: true }),
      col('verified', 'boolean', { nullable: true }),
      col('follower_count', 'int', { nullable: true }),
      col('following_count', 'int', { nullable: true }),
      col('post_count', 'int', { nullable: true }),
    ]),

    // ── Content ─────────────────────────────────────────────────────────────
    createTable('Create posts (text, media, type, visibility, repost link)', 'posts', [
      col('user_id', 'uuid'),
      col('content', 'text'),
      col('media_urls', 'jsonb', { nullable: true }),
      col('post_type', 'text'),                // text | image | video | poll
      col('visibility', 'text'),                // public | followers | private
      col('parent_post_id', 'uuid', { fkTo: 'posts', nullable: true }), // reposts/quotes
      col('like_count', 'int', { nullable: true }),
      col('comment_count', 'int', { nullable: true }),
      col('repost_count', 'int', { nullable: true }),
    ]),

    createTable('Create comments (nested via parent_comment_id)', 'comments', [
      col('post_id', 'uuid', { fkTo: 'posts' }),
      col('user_id', 'uuid'),
      col('content', 'text'),
      col('parent_comment_id', 'uuid', { fkTo: 'comments', nullable: true }),
      col('like_count', 'int', { nullable: true }),
    ]),

    createTable('Create likes (post_id + user_id, unique)', 'likes', [
      col('post_id', 'uuid', { fkTo: 'posts' }),
      col('user_id', 'uuid'),
    ]),

    // ── Social graph ───────────────────────────────────────────────────────
    // Note: the "actor" column is user_id (not follower_id / blocker_id /
    // muter_id) so the owner_read_write RLS template finds it. The target is
    // a second uuid column.
    createTable('Create follows (user follows another user)', 'follows', [
      col('user_id', 'uuid'),
      col('followed_user_id', 'uuid'),
    ]),

    createTable('Create blocks (user blocks another user)', 'blocks', [
      col('user_id', 'uuid'),
      col('blocked_user_id', 'uuid'),
    ]),

    createTable('Create mutes (user mutes another user)', 'mutes', [
      col('user_id', 'uuid'),
      col('muted_user_id', 'uuid'),
    ]),

    createTable('Create bookmarks (post_id + user_id, unique)', 'bookmarks', [
      col('post_id', 'uuid', { fkTo: 'posts' }),
      col('user_id', 'uuid'),
    ]),

    // ── Discovery ───────────────────────────────────────────────────────────
    createTable('Create hashtags (name unique)', 'hashtags', [
      col('name', 'text', { unique: true }),
      col('post_count', 'int', { nullable: true }),
    ]),

    createTable('Create post_hashtags (post_id + hashtag_id)', 'post_hashtags', [
      col('post_id', 'uuid', { fkTo: 'posts' }),
      col('hashtag_id', 'uuid', { fkTo: 'hashtags' }),
    ]),

    // ── Notifications ───────────────────────────────────────────────────────
    createTable('Create notifications (follow / like / comment / mention)', 'notifications', [
      col('user_id', 'uuid'),
      col('from_user_id', 'uuid'),
      col('type', 'text'),               // follow | like | comment | mention | message
      col('target_type', 'text', { nullable: true }), // post | comment | message
      col('target_id', 'uuid', { nullable: true }),
      col('read_at', 'timestamp', { nullable: true }),
    ]),

    // ── DMs ─────────────────────────────────────────────────────────────────
    createTable('Create conversations (DM threads)', 'conversations', [
      col('created_by', 'uuid'),
      col('is_group', 'boolean', { nullable: true }),
      col('title', 'text', { nullable: true }),
      col('last_message_at', 'timestamp', { nullable: true }),
    ]),

    createTable('Create conversation_participants (conversation + user)', 'conversation_participants', [
      col('conversation_id', 'uuid', { fkTo: 'conversations' }),
      col('user_id', 'uuid'),
      col('joined_at', 'timestamp', { nullable: true }),
      col('last_read_at', 'timestamp', { nullable: true }),
    ]),

    createTable('Create messages (DM + group)', 'messages', [
      col('conversation_id', 'uuid', { fkTo: 'conversations' }),
      col('sender_id', 'uuid'),
      col('content', 'text'),
      col('media_url', 'text', { nullable: true }),
      col('read_at', 'timestamp', { nullable: true }),
    ]),

    // ── Stories ─────────────────────────────────────────────────────────────
    createTable('Create stories (ephemeral 24h posts)', 'stories', [
      col('user_id', 'uuid'),
      col('media_url', 'text'),
      col('caption', 'text', { nullable: true }),
      col('expires_at', 'timestamp'),
      col('view_count', 'int', { nullable: true }),
    ]),

    // ── REST APIs for every table ───────────────────────────────────────────
    generateApi('profiles'),
    generateApi('posts'),
    generateApi('comments'),
    generateApi('likes'),
    generateApi('follows'),
    generateApi('blocks'),
    generateApi('mutes'),
    generateApi('bookmarks'),
    generateApi('hashtags'),
    generateApi('post_hashtags'),
    generateApi('notifications'),
    generateApi('conversations'),
    generateApi('conversation_participants'),
    generateApi('messages'),
    generateApi('stories'),

    // ── RLS — owner-based by default, public_read for discoverable content ──
    addRls('profiles', 'public_read', 'Lock down profiles (public read, owner-only write)'),
    addRls('posts', 'public_read', 'Lock down posts (public read, owner-only write)'),
    addRls('comments', 'public_read', 'Lock down comments (public read, owner-only write)'),
    addRls('hashtags', 'public_read', 'Hashtags are public-read'),
    addRls('post_hashtags', 'public_read', 'Post-hashtags are public-read'),
    addRls('stories', 'public_read', 'Stories are public-read, owner-only write'),
    addRls('likes', 'owner_read_write'),
    addRls('follows', 'owner_read_write'),
    addRls('blocks', 'owner_read_write'),
    addRls('mutes', 'owner_read_write'),
    addRls('bookmarks', 'owner_read_write'),
    addRls('notifications', 'owner_read_write'),
    addRls('conversations', 'owner_read_write'),
    addRls('conversation_participants', 'owner_read_write'),
    addRls('messages', 'owner_read_write'),

    // ── Realtime for the live surfaces ──────────────────────────────────────
    enableRealtime('posts'),
    enableRealtime('comments'),
    enableRealtime('likes'),
    enableRealtime('follows'),
    enableRealtime('notifications'),
    enableRealtime('messages'),
    enableRealtime('stories'),

    // ── Notify triggers (fan-out hooks for downstream notifications) ────────
    createTrigger('follows', 'insert'),
    createTrigger('likes', 'insert'),
    createTrigger('comments', 'insert'),
    createTrigger('messages', 'insert'),

    // ── Storage bucket for user media (avatars, posts, stories, DMs) ────────
    {
      label: 'Create media bucket (public-read, owner-write for avatars/posts/stories)',
      tool: 'create_bucket',
      args: { bucketName: 'media', isPublic: true },
    },

    // ── Aggregate stats endpoint for feed dashboards ────────────────────────
    {
      label: 'Generate aggregate /stats/summary endpoint',
      tool: 'generate_aggregate_api',
      args: { name: 'summary' },
    },
  ],
  warnings: [
    'RLS is enabled by default. Unauthenticated tests will return 401/403/permission_denied. That is correct behaviour, not a failure.',
    'Media bucket is public-read so avatars and posts can be embedded directly. Switch to private if your product needs gated media.',
  ],
}
