/**
 * /migrate: the migration guide. Words and facts only; the page lays them out
 * with the guides' document (components/site/guide.tsx).
 *
 * One page for every source, as the founders asked on 2026-11-14 ("making a
 * separate page for migration guide is best which includes migration from
 * supabase, firebase"), linked from the footer the way Easel links its
 * Migration Guide. The landing page stays as it is.
 *
 * 2026-11-15 (founders: "more professional, more animated"): the page is now
 * a product page (app/migrate/page.tsx) rather than a guide document, and
 * each "what comes across" row says which of three things happens to it
 * (`kind`), so the page can draw it.
 *
 * Every line must stay true of the importer as built. 2026-11-21: checked
 * line by line against lib/import as shipped (every read of a source in a
 * sandbox task, lib/import/sandbox.ts) and the console's import flow
 * (components/onboarding). What that changed:
 *   - credentials are kept sealed in the job's record while it runs and
 *     wiped when it ends, so "never stores" became what happens;
 *   - no email is sent when a move ends, and no timing was measured, so
 *     neither is promised;
 *   - Firestore Security Rules are never translated (lib/import/drivers/
 *     firebase-rules.ts); only Supabase and Postgres policies in the shapes
 *     lib/import/rules.ts understands wait for approval;
 *   - foreign keys are created with the tables; arrays stay arrays and
 *     binary columns stay binary (lib/import/pg-plan.ts);
 *   - Backenly serves Google, GitHub, Facebook and Discord sign-in, not
 *     Apple (lib/services/oauth-providers.ts);
 *   - the new project's name starts as the source's name or ref and the
 *     organization is the one you import into, so neither is promised to
 *     carry over.
 */

import type { SourceId } from '@/components/migrate/sources'

export const GUIDE_PATH = '/migrate'
export const GUIDE_UPDATED = '2026-11-21'

export const TITLE = 'Move from Supabase or Firebase'
export const DESCRIPTION =
  'How to move a Supabase, Firebase or Postgres project into Backenly: what comes across, what stays, and how to switch your app over.'

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
    body: 'Paste a Supabase or Postgres connection string, or upload a Firebase service account key. Backenly only reads with it, keeps it encrypted while it works, and erases it when it is done.',
  },
  {
    title: 'Review',
    body: 'See what moves and what stays, then name the new project and pick its region. Nothing is created until you press Move to Backenly.',
  },
  {
    title: 'Move',
    body: 'Every table is copied and its rows are counted on both sides. The move runs on Backenly’s servers, so you can close the tab; your Projects page shows it as Importing until it is done.',
  },
]

/** What happens to a row: it moves, it is translated and waits for your approval, or it stays behind. */
export type AcrossKind = 'moves' | 'approve' | 'stays'

export interface Across {
  have: string
  becomes: string
  kind: AcrossKind
}

export const ACROSS: Record<SourceId, Across[]> = {
  supabase: [
    { have: 'Tables and rows', becomes: 'The public schema’s tables and rows, counted on both sides before the move is called done.', kind: 'moves' },
    {
      have: 'Users and their passwords',
      becomes: 'The same users, with the same ids. Their bcrypt hashes move as they are, so each signs in with the password they have. Phone-only and anonymous users stay behind.',
      kind: 'moves',
    },
    {
      have: 'Storage buckets and files',
      becomes: 'The same buckets, public or private as they were, and their files, once you add the Project URL and service_role key. Files over 100 MB stay behind, and the move says how many.',
      kind: 'moves',
    },
    {
      have: 'Row-level security policies',
      becomes: 'Translated into Backenly access rules when they use the usual shapes, like auth.uid() = user_id, and held for your approval. A table whose policies do not translate answers only your server key.',
      kind: 'approve',
    },
    { have: 'Edge Functions and database functions', becomes: 'Not moved. Your coding agent can rebuild them as Backenly functions.', kind: 'stays' },
  ],
  firebase: [
    { have: 'Firestore collections', becomes: 'Tables, one per collection and subcollection, and one row per document.', kind: 'moves' },
    {
      have: 'Users and their passwords',
      becomes: 'The same users, with their Firebase password hashes, which Backenly checks at sign-in. Phone-only and anonymous users stay behind.',
      kind: 'moves',
    },
    {
      have: 'Users who sign in with Google or another provider',
      becomes: 'The same users. Google, GitHub and Facebook users sign in again once that provider is set up in Backenly; Apple users and others can set a password with a reset email.',
      kind: 'moves',
    },
    { have: 'Cloud Storage files', becomes: 'The default bucket’s files, paths kept, in a private Backenly bucket named files. Files over 100 MB stay behind.', kind: 'moves' },
    { have: 'Security Rules', becomes: 'Not translated. Each moved table answers only your server key until you or your agent add access rules for it.', kind: 'stays' },
    { have: 'Cloud Functions and Realtime Database', becomes: 'Not moved. Your coding agent can rebuild the functions as Backenly functions; Realtime Database data stays in Firebase.', kind: 'stays' },
  ],
  postgres: [
    { have: 'Tables and rows', becomes: 'The same tables and rows, from public or the schemas you name, counted on both sides.', kind: 'moves' },
    {
      have: 'Primary and foreign keys',
      becomes: 'Kept, except keys over more than one column, which the review lists. A primary key that is not a UUID keeps its values (in legacy_id when it was id), and the rows pointing at it follow.',
      kind: 'moves',
    },
    { have: 'Enums, arrays and binary columns', becomes: 'Arrays stay arrays and binary columns stay binary; enums arrive as text. The review lists the columns whose type changes.', kind: 'moves' },
    {
      have: 'Row-level security policies',
      becomes: 'Translated into Backenly access rules when they use shapes Backenly understands, and held for your approval. Any other table answers only your server key.',
      kind: 'approve',
    },
    { have: 'Roles, extensions and server settings', becomes: 'Not moved. Backenly runs the database for you.', kind: 'stays' },
  ],
}

export const SUPABASE_NEEDS = [
  'The project’s connection string: in Supabase, press Connect and copy the Session pooler string (port 5432).',
  'To move Storage files too, the Project URL and the service_role key from Project Settings, then API. Backenly only reads with them, keeps them encrypted while the move runs, and erases them when it ends.',
]

export const SUPABASE_NOTES = [
  'A table whose id is not a UUID, such as a number, keeps it in a legacy_id column and gets a UUID id. The rows that point at it follow, so no row loses its link.',
  'A table named users becomes profiles, because Backenly keeps your app’s users in its own users table.',
  'Enums arrive as text, and arrays stay arrays. The review lists the columns that change type before anything moves.',
  'Foreign keys are created with their tables. A key rows cannot satisfy while they arrive, such as one from a table to itself, is added once the rows are in.',
  'Calls to rpc() do not work on Backenly. Your agent moves that logic into Backenly functions.',
]

export const FIREBASE_NEEDS = [
  'A service account key for the project: in the Firebase console, open Project settings, then Service accounts, and press Generate new private key.',
  'Backenly only reads with it (Firestore and its rules, Authentication, Storage), keeps it encrypted while the move runs, and erases it when the move ends. Delete the key in Firebase afterwards if you like.',
]

export const POSTGRES_NEEDS = [
  'A connection string for a database Backenly can reach over the internet. Backenly connects on port 5432 only.',
  'A read-only user is enough, as long as row-level security hides none of the rows from it.',
]

export const FIREBASE_NOTES = [
  'Each document becomes a row, with its document id in firebase_id. Fields found in up to 1,000 documents of a collection become columns, and a value that does not fit one is kept in an extra_fields JSON column, so nothing is dropped.',
  'Subcollections become tables of their own, with a parent_id column that points at the parent document’s row.',
  'Firebase hashes passwords with its own version of scrypt. Backenly checks those hashes at sign-in and stores a fresh hash the first time each user signs in. If the key cannot read the hashes, the review says so.',
  'Only Firestore moves. Realtime Database data stays in Firebase.',
]

export const FAQ = [
  {
    q: 'Does anything change in my Supabase or Firebase project?',
    a: 'No. Backenly only reads it. Your app keeps running there until you point it at Backenly.',
  },
  {
    q: 'Do my users need new passwords?',
    a: 'Not those who sign in with a password. Supabase’s bcrypt hashes move as they are, and Backenly checks Firebase’s scrypt hashes at sign-in. The review counts the users who sign in another way, and says what happens to them.',
  },
  {
    q: 'What about rows written during the move?',
    a: 'From Supabase or Postgres, a move copies one snapshot, taken as it starts; from Firebase, it says which collections changed while it ran. Rows written later stay where they are. Move again right before you switch your app over: each move makes a new Backenly project, so delete the earlier one.',
  },
  {
    q: 'How long does a move take?',
    a: 'It depends on the size of the project and how fast its source answers; one move can run for up to two hours. It runs on Backenly’s servers, so you can close the tab, and your Projects page shows it as Importing until it is done.',
  },
  {
    q: 'Can my coding agent do the rest?',
    a: 'Yes. Connect Claude Code, Cursor or Codex over MCP and ask it to rebuild what stayed behind and to point your app at Backenly. Each change it makes to the backend is planned, checked and can be undone.',
  },
]
