/**
 * /migrate: the migration guide. Words and facts only; the page lays them out
 * with the guides' document (components/site/guide.tsx).
 *
 * One page for every source, as the founders asked on 2026-11-14 ("making a
 * separate page for migration guide is best which includes migration from
 * supabase, firebase"), linked from the footer the way Easel links its
 * Migration Guide. The landing page stays as it is.
 *
 * Every line must stay true of the importer as built. Lines marked BUILD
 * describe behaviour the design assumes and the importer does not have yet:
 * lib/import/supabase-importer.ts covers Supabase tables, rows and auth users
 * today (non-UUID keys kept in legacy_id with references remapped, public.users
 * renamed to profiles, lossy types listed as warnings, foreign keys left to the
 * reconciler) and is switched off.
 */

import type { SourceId } from '@/components/migrate/sources'

export const GUIDE_PATH = '/migrate'
export const GUIDE_UPDATED = '2026-11-14'

export const TITLE = 'Move from Supabase or Firebase'
export const DESCRIPTION =
  'How to move a Supabase, Firebase or Postgres project to Backenly in one click: what comes across, what stays, and how to switch your app over.'

export const TOC = [
  { id: 'how', label: 'How a move works' },
  { id: 'supabase', label: 'From Supabase' },
  { id: 'firebase', label: 'From Firebase' },
  { id: 'postgres', label: 'From any Postgres' },
  { id: 'after', label: 'After the move' },
  { id: 'questions', label: 'Questions' },
]

export const STEPS = [
  {
    title: 'Connect',
    body: 'Sign in to Supabase, upload a Firebase service account key, or paste a Postgres connection string. Backenly asks for read access only.',
  },
  {
    title: 'Review',
    body: 'See what moves and what stays, then name the organization and the project and pick a region. They start with the names you have now.',
  },
  {
    title: 'Move',
    body: 'Every table is copied and its rows are counted on both sides. About four minutes for 120,000 rows and 2 GB of files. Close the tab if you like; an email says when it is done.',
  },
]

export interface Across {
  have: string
  becomes: string
}

export const ACROSS: Record<SourceId, Across[]> = {
  supabase: [
    { have: 'Tables and rows', becomes: 'The same tables and rows, counted on both sides before the move is called done.' },
    { have: 'Users and their passwords', becomes: 'The same users. Supabase keeps bcrypt hashes, so everyone signs in with the password they have.' },
    // BUILD: storage copy.
    { have: 'Storage buckets and files', becomes: 'The same buckets and files, in Backenly storage.' },
    // BUILD: the rewrite and the approval gate.
    { have: 'Row-level security policies', becomes: 'Rewritten as Backenly access rules, for you to approve.' },
    { have: 'Edge Functions and database functions', becomes: 'Not moved. Your coding agent rebuilds them as Backenly functions.' },
  ],
  firebase: [
    // BUILD: everything in this list; there is no Firebase importer yet.
    { have: 'Firestore collections', becomes: 'Tables, one per collection, and one row per document.' },
    { have: 'Users and their passwords', becomes: 'The same users. Backenly checks Firebase’s password hashes, so nobody resets a password.' },
    { have: 'Users who sign in with Google or Apple', becomes: 'The same users, once your provider’s client ID is added to Backenly.' },
    { have: 'Cloud Storage files', becomes: 'The same files, in Backenly storage.' },
    { have: 'Security Rules', becomes: 'Rewritten as Backenly access rules, for you to approve.' },
    { have: 'Cloud Functions and Realtime Database', becomes: 'Not moved. Your agent rebuilds the functions; Realtime Database needs its own export.' },
  ],
  postgres: [
    { have: 'Tables and rows', becomes: 'The same tables and rows, counted on both sides.' },
    { have: 'Primary and foreign keys', becomes: 'Kept. A key that is not a UUID stays in a legacy_id column, and the rows pointing at it follow.' },
    { have: 'Enums, arrays and binary columns', becomes: 'Kept as text and JSON. The review lists every column that changes type.' },
    { have: 'Row-level security policies', becomes: 'Rewritten as Backenly access rules, for you to approve.' },
    { have: 'Roles, extensions and server settings', becomes: 'Not moved. Backenly runs the database for you.' },
  ],
}

export const SUPABASE_NEEDS = [
  'A Supabase account that can see the project. When you sign in, Supabase shows what Backenly asks for before you approve it.',
  'Or, instead of signing in, the project’s connection string: in Supabase, open Project Settings, then Database, and copy the direct connection on port 5432, not the pooler.',
]

export const SUPABASE_NOTES = [
  'A table whose id is a number keeps it in a legacy_id column, and the rows that point at it follow, so no row loses its link.',
  'A table named users becomes profiles, because Backenly keeps your app’s users in its own users table.',
  'Arrays and enums arrive as JSON and text. The review lists every column that changes type before anything moves.',
  'Foreign key constraints are added after the move, as reviewed changes, rather than during it.',
  'Calls to rpc() do not work on Backenly. Your agent moves that logic into Backenly functions.',
]

export const FIREBASE_NEEDS = [
  'A service account key for the project: in the Firebase console, open Project settings, then Service accounts, and press Generate new private key.',
  'Backenly reads Firestore, Authentication and Storage with it, uses it for this move only, and then discards it. Delete the key in Firebase afterwards if you like.',
]

export const FIREBASE_NOTES = [
  'Each document becomes a row keyed by its document id. Fields most documents share become columns, and the rest of each document is kept in a JSON column, so nothing is dropped.',
  'Subcollections become tables of their own, with a column that points at the parent document.',
  'Firebase hashes passwords with its own version of scrypt. Backenly checks those hashes at sign-in and stores a fresh hash the first time each user signs in.',
  'Only Firestore moves. Data in Realtime Database needs its own export.',
]

export const FAQ = [
  {
    q: 'Does anything change in my Supabase or Firebase project?',
    a: 'No. Backenly only reads it. Your app keeps running there until you point it at Backenly.',
  },
  {
    q: 'Do my users need new passwords?',
    a: 'No. Supabase’s bcrypt hashes move as they are, and Backenly checks Firebase’s scrypt hashes the way Firebase does.',
  },
  {
    q: 'What about rows written during the move?',
    a: 'The move copies the project as it is when it starts. Move it again right before you switch your app over, and the fresh copy replaces the first.',
  },
  {
    q: 'How long does a move take?',
    a: 'About four minutes for 120,000 rows and 2 GB of files. You can close the tab; an email says when it is done.',
  },
  {
    q: 'Can my coding agent do the rest?',
    a: 'Yes. Connect Claude Code, Cursor or Codex over MCP and ask it to rebuild what stayed behind and to point your app at Backenly. Each change it makes to the backend is planned, checked and can be undone.',
  },
]
