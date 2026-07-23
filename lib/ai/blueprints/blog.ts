/**
 * BLOG / CMS BLUEPRINT
 * ====================
 * Backend for any blog / CMS / publishing app (Substack / Medium / Ghost).
 * Posts, categories, tags, comments, subscribers, media, drafts, revisions.
 *
 * Tables (10): authors, posts, categories, tags, post_tags, comments,
 *   subscribers, media, drafts, revisions
 * Storage: post-media bucket (public-read)
 * Realtime: comments
 */

import type { Blueprint, BlueprintColumn } from './types'

const col = (n: string, t: BlueprintColumn['type'], o: Partial<BlueprintColumn> = {}): BlueprintColumn => ({ name: n, type: t, ...o })
const createTable = (label: string, tableName: string, columns: BlueprintColumn[]) => ({ label, tool: 'create_table', args: { tableName, columns } })
const generateApi = (tableName: string) => ({ label: `Generate REST API for ${tableName}`, tool: 'generate_api', args: { tableName } })
const addRls = (tableName: string, policy: string, label?: string) => ({ label: label ?? `Lock down ${tableName} with ${policy} RLS`, tool: 'add_rls', args: { tableName, policy } })
const enableRealtime = (tableName: string) => ({ label: `Stream realtime changes on ${tableName}`, tool: 'enable_realtime', args: { tableName } })

export const BLOG_BLUEPRINT: Blueprint = {
  domain: 'blog',
  title: 'Blog / CMS Backend',
  summary:
    '10 tables (authors, posts, categories, tags, post_tags, comments, subscribers, ' +
    'media, drafts, revisions), public-read on published content, post media storage, ' +
    'realtime on comments.',
  steps: [
    { label: 'Enable end-user authentication (email + password)', tool: 'enable_auth', args: {} },

    createTable('Create authors', 'authors', [
      col('user_id', 'uuid', { unique: true }),
      col('display_name', 'text'),
      col('bio', 'text', { nullable: true }),
      col('avatar_url', 'text', { nullable: true }),
      col('website', 'text', { nullable: true }),
      col('social_links', 'jsonb', { nullable: true }),
    ]),

    createTable('Create categories', 'categories', [
      col('name', 'text'),
      col('slug', 'text', { unique: true }),
      col('description', 'text', { nullable: true }),
    ]),

    createTable('Create tags', 'tags', [
      col('name', 'text'),
      col('slug', 'text', { unique: true }),
    ]),

    createTable('Create posts', 'posts', [
      col('author_id', 'uuid', { fkTo: 'authors' }),
      col('category_id', 'uuid', { fkTo: 'categories', nullable: true }),
      col('title', 'text'),
      col('slug', 'text', { unique: true }),
      col('excerpt', 'text', { nullable: true }),
      col('content', 'text'),
      col('cover_image_url', 'text', { nullable: true }),
      col('status', 'text'),               // draft | scheduled | published | archived
      col('published_at', 'timestamp', { nullable: true }),
      col('view_count', 'int', { nullable: true }),
      col('like_count', 'int', { nullable: true }),
      col('reading_minutes', 'int', { nullable: true }),
    ]),

    createTable('Create post_tags', 'post_tags', [
      col('post_id', 'uuid', { fkTo: 'posts' }),
      col('tag_id', 'uuid', { fkTo: 'tags' }),
    ]),

    createTable('Create comments (nested)', 'comments', [
      col('post_id', 'uuid', { fkTo: 'posts' }),
      col('user_id', 'uuid', { nullable: true }),
      col('parent_comment_id', 'uuid', { fkTo: 'comments', nullable: true }),
      col('author_name', 'text', { nullable: true }),     // guest comments
      col('author_email', 'text', { nullable: true }),
      col('content', 'text'),
      col('approved', 'boolean', { nullable: true }),
    ]),

    createTable('Create subscribers (newsletter list)', 'subscribers', [
      col('email', 'text', { unique: true }),
      col('name', 'text', { nullable: true }),
      col('subscribed_at', 'timestamp', { nullable: true }),
      col('unsubscribed_at', 'timestamp', { nullable: true }),
      col('source', 'text', { nullable: true }),
    ]),

    createTable('Create media (library)', 'media', [
      col('uploaded_by', 'uuid', { fkTo: 'authors', nullable: true }),
      col('url', 'text'),
      col('mime_type', 'text', { nullable: true }),
      col('size_bytes', 'bigint', { nullable: true }),
      col('alt_text', 'text', { nullable: true }),
    ]),

    createTable('Create drafts (auto-save snapshots)', 'drafts', [
      col('post_id', 'uuid', { fkTo: 'posts', nullable: true }),
      col('author_id', 'uuid', { fkTo: 'authors' }),
      col('title', 'text', { nullable: true }),
      col('content', 'text', { nullable: true }),
      col('saved_at', 'timestamp', { nullable: true }),
    ]),

    createTable('Create revisions (post history)', 'revisions', [
      col('post_id', 'uuid', { fkTo: 'posts' }),
      col('author_id', 'uuid', { fkTo: 'authors' }),
      col('title', 'text', { nullable: true }),
      col('content', 'text'),
      col('summary', 'text', { nullable: true }),
    ]),

    generateApi('authors'),
    generateApi('categories'),
    generateApi('tags'),
    generateApi('posts'),
    generateApi('post_tags'),
    generateApi('comments'),
    generateApi('subscribers'),
    generateApi('media'),
    generateApi('drafts'),
    generateApi('revisions'),

    addRls('authors', 'public_read', 'Authors are public-read'),
    addRls('categories', 'public_read'),
    addRls('tags', 'public_read'),
    addRls('posts', 'public_read', 'Posts are public-read, author-only write'),
    addRls('post_tags', 'public_read'),
    addRls('comments', 'public_read', 'Comments are public-read, owner-only write'),
    addRls('media', 'public_read'),
    addRls('subscribers', 'owner_read_write'),
    addRls('drafts', 'owner_read_write'),
    addRls('revisions', 'owner_read_write'),

    enableRealtime('comments'),
    enableRealtime('posts'),

    {
      label: 'Create post-media bucket (public-read)',
      tool: 'create_bucket',
      args: { bucketName: 'post-media', isPublic: true },
    },

    {
      label: 'Generate aggregate /stats/summary endpoint (top posts, views, subscriber growth)',
      tool: 'generate_aggregate_api',
      args: { name: 'summary' },
    },
  ],
}
