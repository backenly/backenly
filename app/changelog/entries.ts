/**
 * The changelog (app/changelog), newest month first.
 *
 * Written by hand from the merged pull requests of backenly/backenly and
 * Backenly Cloud, one entry per change a developer would notice. Left out on
 * purpose: security fixes (they are handled through advisories), internal
 * refactors, tests and CI, the marketing site, and anything still behind a
 * switch that is off by default. `sources` are pull requests in the public
 * repository, linked from the page; Cloud's own changes carry none.
 */

export type ChangelogArea =
  | 'Autonomy'
  | 'Database'
  | 'Auth'
  | 'Storage'
  | 'Functions'
  | 'Realtime'
  | 'MCP and agents'
  | 'Console'
  | 'Self-hosting'
  | 'Billing'
  | 'Platform'

/** New: something you could not do before. Improved: something you could, done better. Fixed: something that was wrong. */
export type ChangelogKind = 'New' | 'Improved' | 'Fixed'

/**
 * The few changes each month shown large, each with the one picture that is
 * true of it: the landing's own figure for the same capability, or code taken
 * from the docs and README. Nothing is drawn for a change that has no picture.
 */
export type ChangelogHighlight = 'session' | 'repair' | 'restructure' | 'history' | 'selfhost' | 'cadence'

export type ChangelogEntry = {
  /** ISO date the change merged (the release records begin in September). */
  date: string
  title: string
  kind: ChangelogKind
  highlight?: ChangelogHighlight
  /** Text with `backticked` code names. */
  body: string
  area: ChangelogArea
  /** Public pull request numbers in backenly/backenly. */
  prs?: number[]
}

export type ChangelogMonth = {
  /** YYYY-MM */
  month: string
  entries: ChangelogEntry[]
  /** Smaller changes that month, one short line each. */
  also?: string[]
}

export const CHANGELOG: ChangelogMonth[] = [
  {
    month: '2026-11',
    entries: [
      {
        date: '2026-11-15',
        area: 'Functions',
        title: "Sign users in from a function",
        kind: 'New',
        highlight: 'session',
        body: "A function that verifies a user its own way, with an SMS code or another identity provider, can now sign them in: call `createSession(userId)`, or `ctx.auth.createSession(userId)` in a sandboxed function. Backenly signs the session, and the token is the same one password sign-in issues, valid for seven days.",
        prs: [780],
      },
      {
        date: '2026-11-15',
        area: 'Auth',
        title: "Magic links and verification emails are sent",
        kind: 'Fixed',
        body: "On Backenly Cloud, magic-link and resend-verification emails for projects on Backenly's built-in email were being logged instead of sent. They are delivered now.",
        prs: [783],
      },
      {
        date: '2026-11-15',
        area: 'Platform',
        title: "@backenly/sdk 0.4.0",
        kind: 'Improved',
        body: "`auth.signUp` and `auth.signIn` send the project key, `create()` returns the new row, and a filter the SDK cannot send in full is refused instead of quietly dropped. `storage.getUrl()` returns an address that serves the file, and the supabase-js shim’s realtime and storage calls work.",
        prs: [646, 630, 731, 750],
      },
      {
        date: '2026-11-14',
        area: 'Functions',
        title: "Failed function runs are not repeated",
        kind: 'Fixed',
        body: "When a function fails after it has started, Backenly no longer runs it again, so rows it inserted and emails it sent are not repeated. A failed HTTP function keeps its logs, and `/fn` answers 402 when a plan limit blocks the call.",
        prs: [760, 761, 762],
      },
      {
        date: '2026-11-14',
        area: 'Functions',
        title: "Stripe events update your tables",
        kind: 'Improved',
        body: "Stripe counts as connected once its webhook signing secret is saved, and the Integrations page shows the endpoint to add in Stripe. Stripe events update the project’s tables and report anything they could not apply. `ctx.integrations.anthropic.complete()` uses a current Claude model and accepts a model name.",
        prs: [755, 757, 759],
      },
      {
        date: '2026-11-13',
        area: 'MCP and agents',
        title: "A lighter tool list for agents",
        kind: 'Improved',
        body: "The tool list an agent session starts with is 36% smaller for read-write keys and 31% smaller for read-only keys. Each tool now states its required arguments, which actions wait for approval and which docs topic to read.",
        prs: [766],
      },
      {
        date: '2026-11-12',
        area: 'Database',
        title: "Migrations create exactly what the SQL says",
        kind: 'Fixed',
        body: "`apply_migration`, branch migrations and merges create each column with the declared type, and `CREATE TABLE` no longer adds unique, check or foreign-key rules guessed from column names. On tables built earlier, Backenly offers to remove the rules it guessed.",
        prs: [640, 654, 677, 763],
      },
      {
        date: '2026-11-12',
        area: 'Database',
        title: "Drop or retype columns through a branch",
        kind: 'New',
        body: "Agents can drop an index, a constraint or a column, or change a column’s type, on a preview branch or with a person’s approval; `apply_migration` used to refuse all of these. It also installs allowlisted extensions with `CREATE EXTENSION`.",
        prs: [645, 657, 765],
      },
      {
        date: '2026-11-10',
        area: 'Database',
        title: "Merge cards show what changes in production",
        kind: 'Improved',
        body: "A branch merge card says what the merge will do to production’s rows, and a merge that would fail on them is refused before anyone is asked to approve it. Branches carry production’s foreign keys, renamed columns show as renames, and an agent can discard its own preview branch.",
        prs: [661, 663, 729, 665, 735],
      },
      {
        date: '2026-11-10',
        area: 'Functions',
        title: "Row functions run only for the columns they watch",
        kind: 'New',
        body: "A row-update function can name the columns it watches and runs only when one of them changes, and row-event runs are queued a few at a time. HTTP functions return the status and body your handler wrote, and can read the project’s environment variables.",
        prs: [650, 658, 649, 655],
      },
      {
        date: '2026-11-10',
        area: 'Auth',
        title: "A password reset page, and auth/me",
        kind: 'New',
        body: "Password reset emails link to a page where your user sets a new password, and `GET /api/v1/{projectId}/auth/me` returns the signed-in user. Auth emails sent without your own SMTP carry your app’s name, and the Auth page says who sends them.",
        prs: [643, 737, 704, 705],
      },
      {
        date: '2026-11-10',
        area: 'Platform',
        title: "API errors say what went wrong",
        kind: 'Improved',
        body: "Every v1 error has a top-level code and message, and `/api/v2` errors use PostgREST’s shape. A refusal names its cause, such as row-level security, a value of the wrong type or a body over the size limit, and an unknown field in a query body gets a 400 instead of being ignored.",
        prs: [747, 723, 681, 682, 684, 642],
      },
      {
        date: '2026-11-10',
        area: 'Autonomy',
        title: "Index repairs no longer block writes",
        kind: 'Improved',
        highlight: 'repair',
        body: "Backenly builds its index repairs with `CREATE INDEX CONCURRENTLY` on a separate connection, so writes keep flowing. Autopilot also builds indexes for queries PostgreSQL measured as slow, and partitioning advice appears only for tables larger than the database’s cache.",
        prs: [651, 652, 675],
      },
      {
        date: '2026-11-02',
        area: 'Console',
        title: "New Autonomy and History pages",
        kind: 'Improved',
        body: "Autonomy has a Review-only or Autopilot switch in its header, and every row is titled in words with at most two buttons. History groups changes by day and shows whether a person, your agent or Backenly made each one.",
        prs: [588],
      },
      {
        date: '2026-11-02',
        area: 'Platform',
        title: "Cloud AI runs on Claude Opus 4.6",
        kind: 'Improved',
        body: "Backend chat, autonomy investigations and support answers on Backenly Cloud run on Claude Opus 4.6, through Amazon Bedrock.",
        prs: [587],
      },
    ],
    also: [
      "Approve several of an agent’s waiting requests at once, from cards that say what approving does.",
      "Realtime sends a large row change with its primary key, and no longer drops events in a burst.",
      "A browser key’s rate limit applies to each visitor separately: 300 requests every 10 seconds by default.",
      "`on_signup` functions also fire for Google, GitHub and magic-link sign-ups.",
      "The portable export keeps row-level security policies.",
    ],
  },
  {
    month: '2026-10',
    entries: [
      {
        date: '2026-10-27',
        area: 'MCP and agents',
        title: "backend_chat keeps working after the call returns",
        kind: 'Improved',
        body: "A `backend_chat` request can run for up to ten minutes. The call waits up to 45 seconds, then returns what has landed so far with `status running`, and `backend_chat status` collects the rest. It also builds up to about six tables per response instead of planning first.",
        prs: [567],
      },
      {
        date: '2026-10-26',
        area: 'Billing',
        title: "Payment emails are receipts",
        kind: 'Improved',
        body: "The email for a plan payment is now a receipt: the amount, the payment method, the billing period and the invoice.",
        prs: [561],
      },
      {
        date: '2026-10-24',
        area: 'Platform',
        title: "One History for every change",
        kind: 'New',
        highlight: 'history',
        body: "History lists every change, from your agent, Backenly or a person, across schema, auth, storage, functions, integrations, webhooks, environment and API keys. Restore one change, or everything after a point, on every plan; restore points are kept 7 days on Free, 30 on Pro and 90 on Enterprise.",
        prs: [545, 556],
      },
      {
        date: '2026-10-24',
        area: 'Autonomy',
        title: "Restructure a table with one approval",
        kind: 'New',
        highlight: 'restructure',
        body: "When columns that belong in a table of their own grow inside another, such as `refund_*` on orders, Backenly can move them out without breaking existing clients. It rehearses on a copy, asks you once, makes the change in steps and never drops the old columns itself.",
        prs: [519, 559, 560],
      },
      {
        date: '2026-10-20',
        area: 'Database',
        title: "An interactive schema diagram",
        kind: 'New',
        body: "The Database page draws your schema as a diagram with foreign-key lines, a focus view of one table’s relationships, search, a minimap and full screen.",
        prs: [439],
      },
      {
        date: '2026-10-18',
        area: 'Database',
        title: "Every schema change gets a checkpoint",
        kind: 'New',
        body: "Every production schema change, from an agent, the console, a branch merge or self-healing, takes a checkpoint and runs a verification the caller cannot weaken. A failed change rolls itself back when nothing would be lost, otherwise a person decides, and dropped tables and columns are kept so the change can be restored.",
        prs: [461],
      },
      {
        date: '2026-10-16',
        area: 'Platform',
        title: "Five regions to choose from",
        kind: 'New',
        body: "Create a project in Mumbai, N. Virginia, Oregon, Frankfurt or Singapore. Its database, files, snapshots, function logs and agent conversations stay in that region, and Connect and Settings show that region’s API address.",
        prs: [341, 396, 395, 410, 411, 416, 417],
      },
      {
        date: '2026-10-16',
        area: 'MCP and agents',
        title: "See and disconnect your agents",
        kind: 'New',
        body: "Connect → Agents lists the agents you authorised by signing in from the browser, and lets you disconnect them. The console also issues read-only MCP keys, and requests waiting for your approval are counted on the Overview and in the top bar.",
        prs: [384, 313, 383],
      },
      {
        date: '2026-10-15',
        area: 'Console',
        title: "A support center in the console",
        kind: 'New',
        body: "Open a support case from the console with a category, a severity and, if you like, the project it is about, then follow it as a thread.",
        prs: [319],
      },
      {
        date: '2026-10-12',
        area: 'Autonomy',
        title: "AI investigations for unexplained findings",
        kind: 'New',
        body: "When Backenly’s checks cannot explain a finding, Claude investigates it from the evidence and the schema’s names, never your rows. It can propose one exact repair, which runs only after a person approves it, counts as fixed only when three checks agree, and can be undone.",
        prs: [267, 268, 277, 278],
      },
      {
        date: '2026-10-07',
        area: 'Console',
        title: "Organizations",
        kind: 'New',
        body: "Projects now live in an organization with its own members, settings, plan, invoices and AI credits; your account became your personal organization and kept what you had paid for. Free has 2 seats and Pro has 5, and invitations are accepted in the console.",
        prs: [212, 214, 211],
      },
      {
        date: '2026-10-05',
        area: 'Database',
        title: "Preview branches with their own endpoint",
        kind: 'Improved',
        body: "Each preview branch has its own endpoint, key and test users, and its traffic stays out of production’s monitoring and autonomy. Agents build on a branch with `apply_migration { branchId }`, and a merge replays the branch’s migrations on production after a person approves.",
        prs: [193, 194, 195, 197, 203],
      },
      {
        date: '2026-10-05',
        area: 'Billing',
        title: "No cap on API requests",
        kind: 'Improved',
        body: "No plan limits API requests, so Free no longer stops at 100,000 in total. Free stays bounded by monthly active users, database size, file storage, egress, function runs and AI credits.",
        prs: [204],
      },
      {
        date: '2026-10-04',
        area: 'Billing',
        title: "Backenly for Startups",
        kind: 'New',
        body: "Startups can apply for free Pro at /startups/apply by confirming a work email at their company’s domain. The founding team reviews every application, and an approved pass moves the account to Pro and ends on its own.",
        prs: [189],
      },
      {
        date: '2026-10-02',
        area: 'Console',
        title: "A redesigned console",
        kind: 'Improved',
        body: "The console is rebuilt on one design system: hairline borders, sentence-case headings and status shown as a coloured dot beside its text. Members, Billing and the organization switcher share the same frame.",
        prs: [184],
      },
    ],
    also: [
      "An agent’s deploy rollback asks a project admin to approve the restore it would run.",
      "Connect gives one install command per coding agent, and adds Antigravity.",
      "The startup pass is now three months of Pro, up from two.",
      "New Cloud accounts get a welcome email, and the critical-issue email says why each issue is waiting for you.",
      "Foreign keys from `apply_migration` keep their declared column, name and `ON DELETE` rule, and cron ranges such as 1-5 fire on every day in the range.",
    ],
  },
  {
    month: '2026-09',
    entries: [
      {
        date: '2026-09-29',
        area: 'Storage',
        title: "Storage follows your plan",
        kind: 'Improved',
        body: "File storage is limited by your plan, so Pro’s 100 GB applies where every project had been capped at 1 GiB. Uploads accept files up to the bucket’s limit, at most 100 MB, and a larger body gets a 413 instead of a 500.",
        prs: [151, 168, 171, 176],
      },
      {
        date: '2026-09-29',
        area: 'Self-hosting',
        title: "Keep snapshots in S3",
        kind: 'New',
        body: "Set `BACKUP_S3_BUCKET` to store project snapshots in S3. Each snapshot is checked by checksum on upload and on restore, and is deleted with its project.",
        prs: [179],
      },
      {
        date: '2026-09-28',
        area: 'Billing',
        title: "Pay for Pro with Stripe",
        kind: 'New',
        body: "Pro checkout runs on Stripe, and Stripe’s customer portal handles your payment method and invoices. A cancelled plan stays on Pro until the end of the period you paid for.",
        prs: [162],
      },
      {
        date: '2026-09-26',
        area: 'Functions',
        title: "Deploy the code your agent wrote",
        kind: 'New',
        body: "`functions { action: \"deploy_code\" }` stores an agent’s code exactly as written, once the runtime has checked it. Runs keep their logs whether they succeed or fail, and agents read them with `functions { action: \"logs\" }`.",
        prs: [131, 128, 140],
      },
      {
        date: '2026-09-26',
        area: 'Database',
        title: "apply_migration stops guessing",
        kind: 'Fixed',
        body: "`apply_migration` refuses `CREATE TABLE` on a table that already exists, with `TABLE_EXISTS`, and no longer creates a missing table on `ALTER TABLE`. `ADD COLUMN` keeps the `NOT NULL`, `DEFAULT`, `UNIQUE` and `REFERENCES` it declares.",
        prs: [134],
      },
      {
        date: '2026-09-25',
        area: 'MCP and agents',
        title: "An MCP tool for each console section",
        kind: 'New',
        body: "Agents get auth, storage, functions, realtime, integrations, monitoring, autonomy, webhooks, deploy and connect tools. Each runs the same operation and permission check as the console, and a call held for approval runs exactly as requested once a person approves it.",
        prs: [119, 125],
      },
      {
        date: '2026-09-25',
        area: 'MCP and agents',
        title: "MCP server 0.4.0",
        kind: 'Improved',
        body: "The remote endpoint and `@backenly/mcp-server` 0.4.0 run on the official MCP SDK and serve hosts on older and current versions of the protocol, with the same results over stdio and remote. The package needs Node.js 20 or newer.",
        prs: [130],
      },
      {
        date: '2026-09-23',
        area: 'Platform',
        title: "Email codes for sign-up and password reset",
        kind: 'New',
        body: "Signing up to Backenly with an email and password confirms the address with a six-digit code before the account exists. Password reset uses a code too, and now works for accounts created with Google or GitHub.",
        prs: [102],
      },
      {
        date: '2026-09-19',
        area: 'Self-hosting',
        title: "Self-host with one command",
        kind: 'New',
        highlight: 'selfhost',
        body: "`npm run selfhost` takes a fresh clone to a ready deployment, filling in missing secrets without rotating existing ones. Running it again upgrades the deployment through its migrations.",
        prs: [49, 69],
      },
      {
        date: '2026-09-19',
        area: 'Platform',
        title: "Webhooks for row changes and sign-ups",
        kind: 'New',
        body: "Webhook endpoints receive `row.inserted`, `row.updated`, `row.deleted` and `auth.user.created` events. Row changes are captured in the database, so writes through the data API trigger them too, and every delivery is signed and retried.",
        prs: [64],
      },
      {
        date: '2026-09-19',
        area: 'Database',
        title: "Snapshots and recovery",
        kind: 'New',
        body: "Database → Snapshots takes and restores one project’s tables, rows, indexes, constraints and row-level security policies. A self-hosted deployment can export everything from Settings → Recovery and restore it with `npm run recovery -- restore`.",
        prs: [63],
      },
      {
        date: '2026-09-19',
        area: 'Auth',
        title: "Send auth email through your own SMTP",
        kind: 'New',
        body: "A project can send its users’ email through its own SMTP server and replace any built-in template. The settings show the result of the last real send, and Send test reports your provider’s reply.",
        prs: [66],
      },
      {
        date: '2026-09-19',
        area: 'Database',
        title: "Extensions and custom types",
        kind: 'New',
        body: "Install allowlisted PostgreSQL extensions from the Database page, or get the exact command where the database does not allow it. Create enums and domains; each type lists the columns that use it and cannot be dropped while any do.",
        prs: [68],
      },
      {
        date: '2026-09-18',
        area: 'Database',
        title: "A read-only SQL workspace",
        kind: 'New',
        body: "The Database page has a SQL workspace that runs every query as the project’s read-only role, inside a read-only transaction. It says when results are truncated and names any columns it redacted.",
        prs: [51],
      },
      {
        date: '2026-09-08',
        area: 'Self-hosting',
        title: "Self-host Backenly for one project",
        kind: 'New',
        body: "Without Cloud configuration, Backenly runs single-tenant: one deployment serving one project. `npm run bootstrap` provisions it and, when rerun, completes only what is missing, and the web and runtime servers build as containers.",
      },
    ],
    also: [
      "New API keys start with `proj_live_`, `svc_live_`, `mcp_live_` or `dk_admin_`; older `sk_` keys keep working.",
      "Daily project backups run on Backenly Cloud.",
      "A fresh self-hosted deployment is claimed from the sign-up page with its setup token.",
      "The project console works on phone screens.",
    ],
  },
  {
    month: '2026-08',
    entries: [
      {
        date: '2026-08-09',
        area: 'Autonomy',
        title: "Undo for automatic fixes",
        kind: 'New',
        body: "Fixes Backenly applied on its own show an Undo button wherever they can be reverted, and undoing a change to row-level security asks you to confirm twice. Each fix records the exact SQL it ran, with a copy button in the Changes panel.",
      },
      {
        date: '2026-08-09',
        area: 'Autonomy',
        title: "Foreign keys and index drops wait for you",
        kind: 'Improved',
        body: "Backenly asks before adding a missing foreign key, naming the target table and the exact `ON DELETE` rule, instead of adding one with `CASCADE` itself. It reports an index only after 14 days without a scan, and drops it only when you approve.",
      },
      {
        date: '2026-08-09',
        area: 'Autonomy',
        title: "Repairs for bloat and failed migrations",
        kind: 'New',
        body: "Backenly rebuilds bloated indexes with `REINDEX CONCURRENTLY` and runs `VACUUM ANALYZE` where autovacuum has fallen behind. It also finds an unfinished concurrent index or a constraint left `NOT VALID` by a failed migration, fixes each with one approval, and reports abandoned prepared transactions.",
      },
      {
        date: '2026-08-09',
        area: 'Autonomy',
        title: "Each backend measured against itself",
        kind: 'New',
        body: "Every hour, Backenly records query latency, sequential scans, table size and connections for each project. When one moves well away from its two-week median, it reports the numbers and what changed just before, and never fixes these findings on its own.",
      },
      {
        date: '2026-08-08',
        area: 'MCP and agents',
        title: "Connect an agent by signing in",
        kind: 'New',
        body: "The remote MCP endpoint supports OAuth, so a host that supports it opens your browser to sign in instead of needing a key pasted into a config file. The consent screen starts with read-only selected.",
      },
      {
        date: '2026-08-08',
        area: 'MCP and agents',
        title: "Read-only keys for agents",
        kind: 'New',
        body: "An MCP key can be issued read-only: its agent is offered only read tools, every write is refused with `READ_ONLY_KEY`, and `backend_chat` is withheld. A key’s mode is fixed when it is issued.",
      },
      {
        date: '2026-08-07',
        area: 'Database',
        title: "Branches as isolated test environments",
        kind: 'Improved',
        body: "A branch gets its own sequences and production’s row-level security policies, and starts without production data unless you ask for a copy. An API key bound to a branch sends its requests there.",
      },
      {
        date: '2026-08-07',
        area: 'Autonomy',
        title: "Indexes for the columns slow queries filter on",
        kind: 'New',
        body: "Backenly reads slow queries from `pg_stat_statements`, checks the filtered column against the catalog and creates the index, and only advises when it cannot verify the column. New checks flag optional foreign keys the data says are required, unique columns without a constraint, enums kept as free text and money stored as a float.",
      },
      {
        date: '2026-08-07',
        area: 'Platform',
        title: "Responses say which layer decided them",
        kind: 'New',
        body: "Data API responses carry `x-backenly-request-id` and `x-backenly-layer` headers, naming the layer behind the result: client, auth, api, database or platform. An empty result from a table with row-level security, read without a user’s token, is attributed to auth.",
      },
      {
        date: '2026-08-05',
        area: 'Database',
        title: "Generated tables accept the rows they need",
        kind: 'Fixed',
        body: "Tables Backenly generates no longer make every column `NOT NULL`. A column is required only when it is a primary key, a foreign key, an email or a username, or when you ask.",
      },
      {
        date: '2026-08-04',
        area: 'Autonomy',
        title: "Self-healing every minute, on every plan",
        kind: 'Improved',
        highlight: 'cadence',
        body: "The repair loop, the contract sweep and the infrastructure scan now run every minute on every plan. The sweep had run every 15 minutes and the scan once a day, so a fixed problem could stay listed for up to 24 hours.",
      },
    ],
    also: [
      "Backenly no longer reports its own internal tables as findings.",
      "Connection health is reported per project instead of for the whole database server.",
      "`generate_function` over MCP draws AI credits for each call.",
    ],
  },
]

/** The newest entry's date, for the page's metadata and the sitemap. */
export const CHANGELOG_UPDATED = CHANGELOG[0]?.entries[0]?.date ?? '2026-11-15'

/** A stable anchor for one change: its date and its title, as a slug. */
export function entrySlug(entry: Pick<ChangelogEntry, 'date' | 'title'>): string {
  const words = entry.title
    .toLowerCase()
    .replace(/@/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${entry.date}-${words}`
}

/** An area as a token for attributes and filters ("MCP and agents" -> "mcp-and-agents"). */
export function areaSlug(area: ChangelogArea): string {
  return area.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

/** Every area that has a change, most changes first, with its count. */
export function areaCounts(): { area: ChangelogArea; slug: string; count: number }[] {
  const counts = new Map<ChangelogArea, number>()
  for (const month of CHANGELOG) for (const e of month.entries) counts.set(e.area, (counts.get(e.area) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([area, count]) => ({ area, slug: areaSlug(area), count }))
}

/** The text with its code marks removed, for places that cannot show code (the RSS feed). */
export function plainText(text: string): string {
  return text.replace(/`/g, '')
}
