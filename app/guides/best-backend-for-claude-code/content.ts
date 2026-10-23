/**
 * The best-backend guide's facts, kept apart from its layout so they can be
 * checked.
 *
 * Backenly wrote this guide and is one of the options in it, so the guide is
 * only worth reading if nothing in it leans. The rules it is held to:
 *
 * - Every statement about another product is a `Claim`: the words, the
 *   vendor's own page it restates (documentation, pricing or official
 *   repository, never a review or recollection), and the day that page was
 *   read. Where the pages say nothing, the claim says "Not documented", never
 *   "No": silence in the docs is not evidence the product cannot do it.
 * - Every statement about Backenly restates this repository: the MCP page's
 *   data (app/mcp/data.ts, itself held to lib/mcp by
 *   tests/unit/mcp-page-conformance.spec.ts), the docs, the pricing page, the
 *   recovery design and the licences.
 * - A criterion is kept only if it could be sourced for every option.
 *
 * tests/unit/best-backend-guide-conformance.spec.ts enforces it: a claim about
 * another product with no source on that vendor's own site, an option missing
 * a criterion, or a Backenly figure that drifted from the code fails it.
 *
 * Inline syntax: `code` renders as inline code (components/site/kit withCode).
 */

import { ADVERTISED_TOOL_COUNT, READ_ONLY_TOOL_COUNT } from '@/app/mcp/data'

export const GUIDE_PATH = '/guides/best-backend-for-claude-code'

/** The last real edit of this guide. Sitemap lastmod and the article's dateModified. */
export const GUIDE_UPDATED = '2026-10-24'

/** The day every vendor page below was read. Re-read them, and move this, when the guide is next revised. */
export const ACCESSED = '2026-10-24'

/** One statement, and the page it restates. */
export type Claim = { text: string; source: string; accessed: string }

export type OptionId = 'supabase' | 'neon' | 'convex' | 'appwrite' | 'firebase' | 'insforge' | 'backenly'

export type CriterionId =
  | 'connect'
  | 'readOnly'
  | 'destructive'
  | 'verify'
  | 'restore'
  | 'afterLaunch'
  | 'model'
  | 'selfHost'
  | 'free'

/** The guide's sections that compare the options, in order. */
export type GroupId = 'agent' | 'changes' | 'running' | 'platform'

const GITHUB = 'https://github.com/backenly/backenly'
const backenlyFile = (path: string) => `${GITHUB}/blob/main/${path}`

/**
 * Every page the guide cites, with the short name its link shows. The row
 * already names the product, so the label only says which page.
 */
export const SOURCES = {
  supabaseMcp: { url: 'https://supabase.com/docs/guides/getting-started/mcp', label: 'MCP server docs' },
  supabaseBackups: { url: 'https://supabase.com/docs/guides/platform/backups', label: 'Backups docs' },
  supabasePricing: { url: 'https://supabase.com/pricing', label: 'Pricing' },
  supabaseSelfHosting: { url: 'https://supabase.com/docs/guides/self-hosting', label: 'Self-hosting docs' },
  supabaseRepo: { url: 'https://github.com/supabase/supabase', label: 'Repository' },
  supabaseAdvisors: { url: 'https://supabase.com/docs/guides/database/database-advisors', label: 'Advisors docs' },

  neonMcp: { url: 'https://neon.com/docs/ai/neon-mcp-server', label: 'MCP server docs' },
  neonMcpRepo: { url: 'https://github.com/neondatabase/mcp-server-neon', label: 'MCP server repository' },
  neonRestore: { url: 'https://neon.com/docs/introduction/branch-restore', label: 'Instant restore docs' },
  neonPricing: { url: 'https://neon.com/pricing', label: 'Pricing' },
  neonRepo: { url: 'https://github.com/neondatabase/neon', label: 'Repository' },
  neonMonitoring: { url: 'https://neon.com/docs/introduction/monitoring', label: 'Monitoring docs' },

  convexMcp: { url: 'https://docs.convex.dev/ai/convex-mcp-server', label: 'MCP server docs' },
  convexSchemas: { url: 'https://docs.convex.dev/database/schemas', label: 'Schemas docs' },
  convexBackups: { url: 'https://docs.convex.dev/database/backup-restore', label: 'Backup and restore docs' },
  convexDatabase: { url: 'https://docs.convex.dev/database', label: 'Database docs' },
  convexSelfHosting: { url: 'https://docs.convex.dev/self-hosting', label: 'Self-hosting docs' },
  convexLimits: { url: 'https://docs.convex.dev/production/state/limits', label: 'Limits docs' },
  convexHealth: { url: 'https://docs.convex.dev/dashboard/deployments/health', label: 'Health page docs' },

  appwriteMcp: { url: 'https://appwrite.io/docs/tooling/mcp', label: 'MCP server docs' },
  appwriteSelfHostedMcp: { url: 'https://appwrite.io/docs/advanced/self-hosting/mcp', label: 'Self-hosted MCP docs' },
  appwriteBackups: { url: 'https://appwrite.io/docs/products/databases/backups', label: 'Backups docs' },
  appwriteDatabases: { url: 'https://appwrite.io/docs/products/databases', label: 'Databases docs' },
  appwriteFreePlan: { url: 'https://appwrite.io/docs/advanced/platform/free', label: 'Free plan docs' },
  appwriteSites: { url: 'https://appwrite.io/docs/products/sites', label: 'Sites docs' },
  appwriteRepo: { url: 'https://github.com/appwrite/appwrite', label: 'Repository' },

  firebaseMcp: { url: 'https://firebase.google.com/docs/ai-assistance/mcp-server', label: 'MCP server docs' },
  firebaseToolsRepo: { url: 'https://github.com/firebase/firebase-tools', label: 'firebase-tools repository' },
  firebaseDataModel: { url: 'https://firebase.google.com/docs/firestore/data-model', label: 'Firestore data model' },
  firebaseSqlConnect: { url: 'https://firebase.google.com/docs/data-connect', label: 'SQL Connect docs' },
  firebaseBackups: { url: 'https://firebase.google.com/docs/firestore/backups', label: 'Firestore backups docs' },
  firebasePitr: { url: 'https://firebase.google.com/docs/firestore/pitr', label: 'Firestore PITR docs' },
  firebaseOffline: { url: 'https://firebase.google.com/docs/firestore/manage-data/enable-offline', label: 'Offline data docs' },
  firebaseEmulators: { url: 'https://firebase.google.com/docs/emulator-suite', label: 'Emulator Suite docs' },
  firebasePricing: { url: 'https://firebase.google.com/pricing', label: 'Pricing' },
  firebaseQueryInsights: { url: 'https://firebase.google.com/docs/firestore/enterprise/query-insights', label: 'Query insights docs' },

  insforgeMcp: { url: 'https://docs.insforge.dev/mcp-setup', label: 'MCP setup docs' },
  insforgeCli: { url: 'https://docs.insforge.dev/agent-native/cli-harness', label: 'CLI docs' },
  insforgeMigrations: { url: 'https://docs.insforge.dev/core-concepts/database/migrations', label: 'Migrations docs' },
  insforgeDiagnostics: { url: 'https://docs.insforge.dev/agent-native/diagnostics', label: 'Diagnostics docs' },
  insforgeBackups: { url: 'https://docs.insforge.dev/core-concepts/database/backups', label: 'Backups docs' },
  insforgeBranching: { url: 'https://docs.insforge.dev/agent-native/branching', label: 'Branching docs' },
  insforgeProducts: { url: 'https://docs.insforge.dev/products', label: 'Products docs' },
  insforgeSelfHost: { url: 'https://docs.insforge.dev/deployment/deploy-to-aws-ec2', label: 'Self-hosting docs' },
  insforgePricing: { url: 'https://insforge.dev/pricing', label: 'Pricing' },
  insforgeRepo: { url: 'https://github.com/InsForge/InsForge', label: 'Repository' },

  backenlyMcp: { url: backenlyFile('app/mcp/data.ts'), label: 'app/mcp/data.ts' },
  backenlyVerify: { url: backenlyFile('lib/changes/verify.ts'), label: 'lib/changes/verify.ts' },
  backenlyRecovery: { url: backenlyFile('docs/CHANGE_RECOVERY.md'), label: 'docs/CHANGE_RECOVERY.md' },
  backenlyDocs: { url: backenlyFile('app/docs/content.ts'), label: 'app/docs/content.ts' },
  backenlyPricing: { url: backenlyFile('app/pricing/page.tsx'), label: 'app/pricing/page.tsx' },
  backenlyComparisons: { url: backenlyFile('app/comparisons/data.ts'), label: 'app/comparisons/data.ts' },
  backenlyPackages: { url: `${GITHUB}/tree/main/packages`, label: 'packages/' },
} as const satisfies Record<string, { url: string; label: string }>

type SourceKey = keyof typeof SOURCES

/** A claim restating `source`, read on ACCESSED. */
function claim(source: SourceKey, text: string): Claim {
  return { text, source: SOURCES[source].url, accessed: ACCESSED }
}

/** The link text for a cited URL. */
export function sourceLabel(url: string): string {
  return Object.values(SOURCES).find((s) => s.url === url)?.label ?? url
}

/** Whether a claim restates this repository rather than another vendor's pages. */
export function isBackenlySource(url: string): boolean {
  return url.startsWith(`${GITHUB}/`)
}

export type Option = {
  id: OptionId
  name: string
  /** Where this option's sources may live: the vendor's own site and its GitHub organization. */
  hosts: readonly string[]
}

/** The options, in the order the tables list them. Backenly last: it wrote the guide. */
export const OPTIONS: Option[] = [
  { id: 'supabase', name: 'Supabase', hosts: ['supabase.com', 'github.com/supabase'] },
  { id: 'neon', name: 'Neon', hosts: ['neon.com', 'github.com/neondatabase'] },
  { id: 'convex', name: 'Convex', hosts: ['docs.convex.dev', 'github.com/get-convex'] },
  { id: 'appwrite', name: 'Appwrite', hosts: ['appwrite.io', 'github.com/appwrite'] },
  { id: 'firebase', name: 'Firebase', hosts: ['firebase.google.com', 'github.com/firebase'] },
  { id: 'insforge', name: 'InsForge', hosts: ['docs.insforge.dev', 'insforge.dev', 'github.com/InsForge'] },
  { id: 'backenly', name: 'Backenly', hosts: ['github.com/backenly/backenly'] },
]

export type Criterion = {
  id: CriterionId
  group: GroupId
  /** The question, as the table's heading. */
  title: string
  /** Why it matters when an agent writes to production, in one or two sentences. */
  why: string
}

export const CRITERIA: Criterion[] = [
  {
    id: 'connect',
    group: 'agent',
    title: 'How the agent connects',
    why: 'An official MCP server is maintained by the vendor with the product. A hosted one needs nothing installed; a local one runs on your machine with the credentials it finds there.',
  },
  {
    id: 'readOnly',
    group: 'agent',
    title: 'A read-only mode',
    why: 'Most of an agent’s calls only read. A read-only connection, enforced by the server or by database grants rather than by instructions, means a misread request cannot write.',
  },
  {
    id: 'destructive',
    group: 'changes',
    title: 'What happens to DROP and delete',
    why: 'One call can drop a table. Check whether the server refuses it, asks a person, or runs it, and whether your client’s own prompt is the only thing in the way.',
  },
  {
    id: 'verify',
    group: 'changes',
    title: 'Whether schema changes are checked',
    why: 'A migration can run without an error and still break the app. Check whether the platform tests the result, or whether that is left to you and the agent.',
  },
  {
    id: 'restore',
    group: 'changes',
    title: 'Restore points and branches',
    why: 'When a change goes wrong: how far back you can go, what a restore does to data written since, and what the free plan includes.',
  },
  {
    id: 'afterLaunch',
    group: 'running',
    title: 'What happens to problems after launch',
    why: 'Most problems show up after the agent’s session ends: a slow query, a missing index, a table open to everyone. Check whether the platform only reports them, or also fixes the safe ones itself.',
  },
  {
    id: 'model',
    group: 'platform',
    title: 'The data model',
    why: 'Tables or documents decide how the agent models your data, and it is the choice that is hardest to undo later.',
  },
  {
    id: 'selfHost',
    group: 'platform',
    title: 'Self-hosting and licence',
    why: 'Whether you can run the backend yourself, and under which licence, if the hosted service stops suiting you.',
  },
  {
    id: 'free',
    group: 'platform',
    title: 'The free tier',
    why: 'What you can build before paying, and the limits you reach first.',
  },
]

/**
 * What each option documents, criterion by criterion. Short and literal: a
 * cell restates its sources, and a reader can check each in one click.
 */
export const COMPARISON: Record<OptionId, Record<CriterionId, Claim[]>> = {
  supabase: {
    connect: [
      claim(
        'supabaseMcp',
        'Official MCP server, hosted at `mcp.supabase.com/mcp`. A local one runs with the Supabase CLI for local development.',
      ),
    ],
    readOnly: [
      claim(
        'supabaseMcp',
        'Yes. `read_only=true` runs every query as a read-only Postgres user, and `project_ref` scopes the server to one project.',
      ),
    ],
    destructive: [
      claim(
        'supabaseMcp',
        '`execute_sql` and `apply_migration` ask for confirmation when they detect destructive SQL, if your client supports it. The docs call this a guardrail that may not catch every destructive operation.',
      ),
    ],
    verify: [
      claim(
        'supabaseMcp',
        'Not documented as a check after a migration. `get_advisors` returns security and performance advisors when the agent calls it.',
      ),
    ],
    restore: [
      claim(
        'supabaseBackups',
        'Daily backups on Pro and above, the last 7 days on Pro; point-in-time recovery is an add-on. The project is inaccessible while a restore runs.',
      ),
      claim('supabasePricing', 'Free includes no automatic backups, point-in-time recovery or branching.'),
    ],
    afterLaunch: [
      claim(
        'supabaseAdvisors',
        'Advisors flag health, security and performance issues. The documented fixes are SQL or settings changes you run.',
      ),
    ],
    model: [claim('supabasePricing', 'PostgreSQL. Every project comes with its own Postgres instance.')],
    selfHost: [
      claim('supabaseRepo', 'Apache-2.0.'),
      claim(
        'supabaseSelfHosting',
        'Self-hosting with Docker is documented. Branching, managed backups and point-in-time recovery are not available self-hosted.',
      ),
    ],
    free: [
      claim(
        'supabasePricing',
        '$0: 2 active projects and a 500 MB database per project. Free projects are paused after a week of inactivity.',
      ),
    ],
  },

  neon: {
    connect: [
      claim('neonMcp', 'Official MCP server, hosted at `mcp.neon.tech/mcp`. The local stdio package is deprecated.'),
    ],
    readOnly: [
      claim(
        'neonMcp',
        'Yes. `readonly=true` keeps SELECT queries and schema inspection and turns writes off. `roleName` makes the SQL tools log in as a Postgres role you choose.',
      ),
    ],
    destructive: [claim('neonMcp', 'Not documented. The docs say to review and authorize every action the LLM requests.')],
    verify: [
      claim(
        'neonMcpRepo',
        '`prepare_database_migration` applies a migration to a temporary branch so it can be tested; `complete_database_migration` then applies it to the main branch.',
      ),
    ],
    restore: [
      claim(
        'neonRestore',
        'Instant restore returns a root branch to any point in its history window, and keeps the state before the restore as a backup branch.',
      ),
      claim('neonPricing', 'On Free the window is up to 6 hours or 1 GB of changes, with 10 branches per project and 1 snapshot.'),
    ],
    afterLaunch: [
      claim(
        'neonMonitoring',
        'Monitoring, query performance and logs, plus Data API Advisors that detect security and performance issues. Fixes it applies itself: Not documented.',
      ),
    ],
    model: [claim('neonMcp', 'PostgreSQL, organized in projects and branches.')],
    selfHost: [
      claim(
        'neonRepo',
        'Apache-2.0. Self-hosting: Not documented. The README covers running Neon on a workstation for small experiments.',
      ),
    ],
    free: [
      claim(
        'neonPricing',
        '$0 with no credit card: 100 projects, with 1 GB of storage and 100 CU-hours of compute a month per project.',
      ),
    ],
  },

  convex: {
    connect: [
      claim(
        'convexMcp',
        'Official MCP server, run locally with `npx convex mcp start`. It connects to your development deployment by default.',
      ),
    ],
    readOnly: [
      claim(
        'convexMcp',
        'On a production deployment, by default, only read-only tools that expose no personal data. `--disable-tools` turns off any tool.',
      ),
    ],
    destructive: [
      claim(
        'convexMcp',
        'The write tools (`run`, `envSet`, `envRemove`) are blocked on production unless the server starts with `--dangerously-enable-production-deployments`. On development deployments every tool is allowed.',
      ),
    ],
    verify: [
      claim(
        'convexSchemas',
        'The first push after a schema change validates every existing document against it, and the push fails if any do not match. Later inserts and updates are validated too.',
      ),
    ],
    restore: [
      claim(
        'convexBackups',
        'Backups of table data: up to two per deployment on Free, scheduled daily or weekly on Pro. A restore wipes the existing data and replaces it with the backup’s.',
      ),
    ],
    afterLaunch: [
      claim(
        'convexHealth',
        'The Health page shows the failure rate and insights with suggestions to improve performance and reliability, each linking to how to resolve it. Fixes it applies itself: Not documented.',
      ),
    ],
    model: [claim('convexDatabase', 'A relational data model over JSON-like documents in tables, with or without a schema.')],
    selfHost: [
      claim(
        'convexSelfHosting',
        'Self-hosting is documented and runs the same code as the cloud service. The FSL Apache 2.0 licence allows almost anything Apache-2.0 does except a product that competes with Convex Cloud, and code becomes Apache-2.0 two years after it is written.',
      ),
    ],
    free: [claim('convexLimits', 'Hard caps: 0.5 GB of database storage and 1,000,000 function calls a month.')],
  },

  appwrite: {
    connect: [
      claim('appwriteMcp', 'Official MCP server, hosted at `mcp.appwrite.io` for Appwrite Cloud, with an OAuth sign-in.'),
      claim('appwriteSelfHostedMcp', 'Self-hosted Appwrite uses a local server over stdio instead.'),
    ],
    readOnly: [
      claim('appwriteMcp', 'Not documented.'),
      claim(
        'appwriteSelfHostedMcp',
        'The local server for self-hosted Appwrite connects with an API key you create with the scopes it needs.',
      ),
    ],
    destructive: [claim('appwriteMcp', 'Not documented.')],
    verify: [claim('appwriteDatabases', 'Not documented.')],
    restore: [
      claim('appwriteBackups', 'Backups on Pro and Enterprise, with a daily backup policy on Pro. A restore creates a new database.'),
    ],
    afterLaunch: [claim('appwriteDatabases', 'Not documented.')],
    model: [
      claim(
        'appwriteDatabases',
        'TablesDB (typed columns, rows and relationships), DocumentsDB (schemaless documents), or managed PostgreSQL and MySQL on dedicated infrastructure.',
      ),
    ],
    selfHost: [claim('appwriteRepo', 'BSD-3-Clause. Self-hosting with Docker is documented.')],
    free: [claim('appwriteFreePlan', 'One organization and 2 projects per account, sharing the plan’s resources.')],
  },

  firebase: {
    connect: [
      claim(
        'firebaseMcp',
        'Official MCP server in firebase-tools, run locally over stdio. It acts with the credentials your Firebase CLI is signed in with.',
      ),
    ],
    readOnly: [
      claim('firebaseMcp', 'Not documented. `--only` limits the tools to the feature groups you name; the core tools are always on.'),
    ],
    destructive: [
      claim(
        'firebaseMcp',
        'Not documented, beyond a note that the tools act “with your approval”. They include `firestore_delete_document` and `firestore_delete_database`.',
      ),
    ],
    verify: [claim('firebaseDataModel', 'Firestore is schemaless: documents in the same collection can have different fields.')],
    restore: [
      claim(
        'firebaseBackups',
        'Scheduled Firestore backups, kept up to 14 weeks and restored to a new database, need the Blaze plan.',
      ),
      claim('firebasePitr', 'Point-in-time recovery keeps up to 7 days and needs billing enabled.'),
    ],
    afterLaunch: [
      claim(
        'firebaseQueryInsights',
        'Query insights, in the Enterprise edition, shows query latency and reads for tuning. Fixes it applies itself: Not documented.',
      ),
    ],
    model: [
      claim('firebaseDataModel', 'Cloud Firestore: documents in collections, with no tables or rows.'),
      claim('firebaseSqlConnect', 'SQL Connect, formerly Data Connect, is a separate PostgreSQL service on Cloud SQL.'),
    ],
    selfHost: [
      claim(
        'firebaseEmulators',
        'Not documented. The docs say not to use the local emulators as self-hosted versions of Firebase services.',
      ),
      claim('firebaseToolsRepo', 'firebase-tools, which contains the MCP server, is MIT.'),
    ],
    free: [
      claim(
        'firebasePricing',
        'The Spark plan needs no payment method. Firestore is free up to 1 GiB stored, 50,000 reads and 20,000 writes a day.',
      ),
    ],
  },

  insforge: {
    connect: [
      claim(
        'insforgeMcp',
        'Official MCP server for Claude Code, Cursor, Codex and other clients. Write and admin actions need your admin API key.',
      ),
      claim('insforgeCli', 'A CLI, `@insforge/cli`, gives the agent the schema, config, deploys and diagnostics as JSON.'),
    ],
    readOnly: [claim('insforgeMcp', 'Not documented. Write and admin actions need your admin API key.')],
    destructive: [
      claim(
        'insforgeMcp',
        '`run-raw-sql` runs raw SQL in strict mode with the admin key, with system tables and `auth.users` blocked. The tools include `delete-bucket` and `delete-function`. A step that waits for a person: Not documented.',
      ),
    ],
    verify: [
      claim(
        'insforgeMigrations',
        'Not documented as a check after a change. Migrations are forward-only SQL files the CLI applies in a transaction and records only on success.',
      ),
    ],
    restore: [
      claim(
        'insforgeBackups',
        'Daily backups on paid plans, kept 7 days, and manual backups: 1 slot on Free, 5 on paid plans. A restore replaces the database: the project goes offline, data created after the backup is lost, and the restore cannot be undone.',
      ),
      claim(
        'insforgeBranching',
        'A branch is a child project with its own Postgres, auth, storage and functions, merged back with a three-way diff or reset to its starting snapshot. Two active branches per parent.',
      ),
    ],
    afterLaunch: [
      claim(
        'insforgeDiagnostics',
        'An advisor scans for security, performance and health issues and writes a remediation for each. The agent fetches the findings and applies the fix itself.',
      ),
    ],
    model: [claim('insforgeProducts', 'PostgreSQL for every project, with every table served as a typed REST and SDK surface.')],
    selfHost: [
      claim('insforgeRepo', 'Apache-2.0.'),
      claim('insforgeSelfHost', 'Self-hosting with Docker Compose is documented.'),
    ],
    free: [
      claim(
        'insforgePricing',
        '$0: a 500 MB database, 1 GB of file storage and 50,000 monthly active users. Free projects are paused after a week of inactivity.',
      ),
    ],
  },
  backenly: {
    connect: [
      claim(
        'backenlyMcp',
        'Official MCP server, remote at `backenly.com/api/mcp` or local over stdio with `@backenly/mcp-server`. It operates a Backenly project, on Cloud or self-hosted, not a Postgres database Backenly does not run.',
      ),
    ],
    readOnly: [
      claim(
        'backenlyMcp',
        `Yes. A read-only key or connection sees ${READ_ONLY_TOOL_COUNT} of the ${ADVERTISED_TOOL_COUNT} tools, a write called anyway is refused with \`READ_ONLY_KEY\`, and an agent cannot upgrade its own key.`,
      ),
    ],
    destructive: [
      claim(
        'backenlyMcp',
        '`apply_migration` refuses DROP with `DESTRUCTIVE_REFUSED`. Dropping a table or column, deleting files and revoking keys wait for a person to approve. Row inserts, updates and deletes run as normal.',
      ),
    ],
    verify: [
      claim(
        'backenlyVerify',
        'Backenly checks each schema change after it runs: every reported step happened, nothing disappeared as a side effect, and row-level security was not weakened. A check that could not run leaves the change marked unverified.',
      ),
    ],
    restore: [
      claim(
        'backenlyRecovery',
        'Every change, to the schema, auth, storage, functions, webhooks, environment variables, keys or integrations, is one entry in History. Restore it alone, or everything back to a point; data your app wrote is never rewound, and a secret never comes back.',
      ),
      claim(
        'backenlyPricing',
        'A restore point before each schema change, kept 7 days on Free and 30 on Pro; each change shows whether it can still be restored. Daily backups are kept 7 days.',
      ),
      claim('backenlyRecovery', 'A restore that would affect data written since the change waits for a person, who sees the impact first.'),
      claim('backenlyDocs', 'Branches, copies of the schema to try a change on first, are in beta on Backenly Cloud.'),
    ],
    afterLaunch: [
      claim(
        'backenlyDocs',
        'Checked every minute on every plan, Free included. It applies a short list of safe, additive fixes itself, such as a missing index, verifies and records each one, and holds anything risky for a person.',
      ),
    ],
    model: [claim('backenlyDocs', 'PostgreSQL. Each project has its own schema, and every table is served as a REST API.')],
    selfHost: [
      claim('backenlyPricing', 'The platform is Apache-2.0 and free to self-host.'),
      claim('backenlyPackages', 'The SDK, CLI and MCP server are MIT.'),
    ],
    free: [claim('backenlyPricing', '$0 with no credit card: 1 live project and a 512 MB Postgres database.')],
  },
}

/** Context printed under a criterion's table: what the vendors themselves advise. */
export const NOTES: Partial<Record<CriterionId, Claim[]>> = {
  readOnly: [
    claim('neonMcp', 'Neon recommends its MCP server for development and testing only, not production environments.'),
    claim(
      'supabaseMcp',
      'Supabase says to connect a production project only when the task needs production evidence, and to scope the server and turn on read-only mode first.',
    ),
  ],
  destructive: [claim('supabaseMcp', 'As Supabase’s docs note, most MCP clients also ask you to accept each tool call before it runs.')],
}

export type Alternative = {
  /** The situation, as a reader would recognise it. */
  when: string
  /** What the other option documents, then what Backenly does instead. */
  claims: Claim[]
}

/** When to pick something other than Backenly. Each names the other option's strength in its own docs' terms. */
export const ALTERNATIVES: Alternative[] = [
  {
    when: 'You already run a Supabase project.',
    claims: [
      claim(
        'supabaseMcp',
        'Supabase’s MCP server works on it as it is, with project scoping and a read-only mode, and its tools also cover Edge Functions and account management.',
      ),
      claim(
        'backenlyComparisons',
        'Moving to Backenly means a `pg_dump` of the data and rewriting your row-level security policies, and there is no migration service to do it for you.',
      ),
    ],
  },
  {
    when: 'You want point-in-time restore and many free databases on plain Postgres.',
    claims: [
      claim(
        'neonRestore',
        'Neon restores a branch to any point in its history window and keeps the state before the restore as a branch you can go back to.',
      ),
      claim('neonPricing', 'Its Free plan includes 100 projects.'),
      claim('backenlyPricing', 'Backenly’s Free plan has one live project.'),
    ],
  },
  {
    when: 'Your data is documents, and you want writes checked against a schema.',
    claims: [
      claim(
        'convexSchemas',
        'Convex validates documents against your schema, and a push that changes the schema fails if existing documents do not match it.',
      ),
      claim(
        'convexMcp',
        'Its MCP server keeps an agent from writing to a production deployment unless you start it with a flag.',
      ),
      claim('backenlyDocs', 'Backenly keeps your data in PostgreSQL tables.'),
    ],
  },
  {
    when: 'Your app must keep working offline on a phone.',
    claims: [
      claim(
        'firebaseOffline',
        'Firestore caches the data an app is using, so reads, writes and queries keep working offline and sync when the device reconnects. This is on by default on Android and Apple platforms.',
      ),
      claim('backenlyComparisons', 'Backenly has no offline layer.'),
    ],
  },
  {
    when: 'You want a model gateway, payments and site hosting in the same platform as the backend.',
    claims: [
      claim(
        'insforgeProducts',
        'InsForge ships ten products behind one MCP server and SDK, among them sites, a model gateway, analytics and payments.',
      ),
      claim(
        'insforgeBranching',
        'Its branches copy the whole backend, auth, storage and functions included.',
      ),
      claim('backenlyComparisons', 'Backenly’s branches cover data and the REST API; auth, functions and storage stay on main.'),
    ],
  },
  {
    when: 'You want one platform to host your web app as well.',
    claims: [
      claim(
        'appwriteSites',
        'Appwrite Sites deploys web apps from source control, each with its own URL, custom domains and environment variables.',
      ),
      claim('backenlyDocs', 'Backenly publishes the backend; your frontend is hosted wherever you choose.'),
    ],
  },
]

/** The guide's last section: where to go from here. Each link must resolve (the conformance test checks). */
export const READ_NEXT = [
  {
    href: '/mcp',
    meta: 'MCP server',
    title: 'What your agent can call',
    body: 'Backenly’s tools, the install for Claude Code and other clients, and what waits for you.',
  },
  {
    href: '/guides/safe-ai-database-changes',
    meta: 'Guide',
    title: 'Safe database changes with AI coding agents',
    body: 'How Backenly checkpoints, verifies and recovers an agent’s schema changes, and why some undos need a person.',
  },
  {
    href: '/comparisons/backenly-vs-supabase',
    meta: 'Comparison',
    title: 'Backenly vs Supabase',
    body: 'The same Postgres and query API. The difference is who handles schema changes, access rules and upkeep.',
  },
] as const
