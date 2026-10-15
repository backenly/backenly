/**
 * Content for /docs: one page per section of the project console.
 *
 * The docs mirror the console sidebar (components/shell/ProjectSidebar.tsx):
 * the same sections, in the same order, under the same groups. Someone who does
 * not know what Storage or Functions is for is usually looking at that sidebar
 * when the question comes up, so the page they land on is named and ordered
 * exactly like it.
 *
 * Every page answers the same four questions in the same order: why you would
 * need it, how it works, how to try it, and what to know before relying on it.
 * Keeping the shape fixed is what lets a reader compare two sections at a
 * glance.
 *
 * Every claim must be true of the live product. A capacity that varies by plan
 * points at /pricing instead of restating a number that can move.
 *
 * Plain data, no React: scripts/verify-content-integrity.ts imports this file
 * as a build gate. Icons live in components/docs/DocIcon.tsx, and walkthrough
 * videos in ./videos.ts.
 *
 * Inline syntax inside strings: `code` renders as inline code, and
 * [label](/path) as a link (summary, why and notes only). The integrity gate
 * checks that every internal link resolves.
 */

export const DOC_SLUGS = [
  'database',
  'auth',
  'storage',
  'functions',
  'realtime',
  'integrations',
  'autonomy',
  'monitoring',
  'branches',
  'deploy',
  'connect',
  'webhooks',
  'settings',
] as const

export type DocSlug = (typeof DOC_SLUGS)[number]

export type DocGroupId = 'build' | 'operate' | 'connect' | 'project'

export type DocGroup = {
  id: DocGroupId
  label: string
  /** One line under the group's name on the docs home page. */
  blurb: string
  /**
   * Whether the console sidebar shows this label above the group. Settings
   * stands alone at the foot of the console sidebar; "Project" is a docs-only
   * heading, so it never appears in an "In the console" path.
   */
  inConsole: boolean
}

export type DocStep = { title: string; body: string }

export type DocCode = { label: string; language: string; code: string }

export type DocSection = {
  slug: DocSlug
  /** The console's own label for the section. */
  title: string
  /** The small tag beside the label in the console sidebar, e.g. MCP or Beta. */
  tag?: string
  group: DocGroupId
  /** One line for the docs home page: what the section is for. */
  purpose: string
  /** The paragraph under the title: what it is, in concrete terms. */
  summary: string
  metaDescription: string
  /** The problem it solves. */
  why: string
  /** Situations a reader will recognise from their own app. */
  examples: string[]
  /** The mechanism, in order. */
  how: DocStep[]
  /** Requests to give a coding agent connected over MCP. */
  prompts: string[]
  /** One short snippet, where code makes the mechanism concrete. */
  code?: DocCode
  /** Limits, plan gates, and what the section does not do. */
  notes: string[]
}

/** The four headings every page renders, in order. Anchors are stable. */
export const DOC_HEADINGS = [
  { id: 'why', label: 'Why you need it' },
  { id: 'how', label: 'How it works' },
  { id: 'try', label: 'Try it' },
  { id: 'notes', label: 'Good to know' },
] as const

export const DOCS_UPDATED = { iso: '2026-10-12', display: 'October 12, 2026' } as const

export const DOC_GROUPS: DocGroup[] = [
  {
    id: 'build',
    label: 'Build',
    blurb: 'What your app is made of: its data, its users, its files, its server code, its live updates and the services it calls.',
    inConsole: true,
  },
  {
    id: 'operate',
    label: 'Operate',
    blurb: 'What keeps the backend healthy after launch, and how a change reaches production.',
    inConsole: true,
  },
  {
    id: 'connect',
    label: 'Connect',
    blurb: 'How your coding agent, your app and your other services reach the backend.',
    inConsole: true,
  },
  {
    id: 'project',
    label: 'Project',
    blurb: 'API keys, access, and the project itself.',
    inConsole: false,
  },
]

export const DOC_SECTIONS: DocSection[] = [
  // ── Build ──────────────────────────────────────────────────────────────────
  {
    slug: 'database',
    title: 'Database',
    group: 'build',
    purpose: 'Your app’s data, in PostgreSQL tables, with an API for every table.',
    summary:
      'Database holds your app’s data in PostgreSQL tables: posts, orders, messages, anything your app needs to remember. Every table is served as a REST API the moment it exists, and row-level security decides which rows each signed-in user can read and change.',
    metaDescription:
      'What the Database section does: PostgreSQL tables your coding agent creates, a REST API for every table, row-level security, and how a schema change is planned, applied and rolled back.',
    why:
      'Almost every app has to remember things between visits: who ordered what, which tasks are done, what a user wrote. That is the database. On Backenly you do not write the server code that usually sits in front of it. Your agent creates the tables, Backenly serves them as an API, and the access rules run inside PostgreSQL, so a filter forgotten on one screen cannot show one user another user’s data.',
    examples: [
      'A task app stores projects and the tasks inside them, and each user sees only their own.',
      'A shop stores products, orders and order items, linked by foreign keys.',
      'A chat app stores conversations and messages that only the two people in the conversation can read.',
      'You answer a question about your data with a read-only SQL query, without any risk of changing it.',
    ],
    how: [
      {
        title: 'Your agent asks for the change',
        body: 'With ordinary PostgreSQL DDL through `apply_migration`, or by describing the tables to `backend_chat`. Either way Backenly turns the request into typed actions rather than running raw SQL, and refuses anything it cannot map.',
      },
      {
        title: 'Backenly applies the checked steps',
        body: 'Tables are created in your project’s own PostgreSQL schema, with a schema snapshot before a change. A multi-statement migration is checked before any step runs; if execution fails, it stops and reports what applied and what remains, so your agent can finish without replaying completed work.',
      },
      {
        title: 'Every table gets an API',
        body: '`/api/v1/{projectId}/db/{table}` lists, creates, reads, updates and deletes rows, with filters, sorting and pagination. There is no generate step and nothing to keep in sync.',
      },
      {
        title: 'The rules run in the database',
        body: 'Row-level security policies read the signed-in user from each request, so the same rule holds through the REST API and the SDK. After a build, Backenly signs in a second test user and checks they cannot read the first user’s rows.',
      },
    ],
    prompts: [
      'Create a tasks table with a title, a status of todo, in_progress or done, and a due date. Each user can only see and edit their own tasks.',
      'Add a comments table. Each task has many comments, and each comment belongs to the user who wrote it.',
    ],
    code: {
      label: 'From your app',
      language: 'js',
      code: `import { createClient } from '@backenly/sdk'

const backend = createClient({ projectId, apiKey })

const open = await backend.tasks.list({ where: { status: 'todo' }, limit: 25 })
await backend.tasks.create({ title: 'Ship onboarding', status: 'todo' })`,
    },
    notes: [
      'A request without a signed-in user’s token reads zero rows from a protected table instead of failing. If a list is unexpectedly empty, check the `X-User-Token` header before the data.',
      'Every table Backenly creates gets `id`, `"createdAt"`, `"updatedAt"` and `deleted_at`. Rows with a `deleted_at` time are left out of API reads unless the request asks for `include_deleted=true`.',
      'Dropping a table or a column never runs straight from your agent. It waits in the [Autonomy](/docs/autonomy) review queue until a person approves it.',
      'There is no `rpc()` endpoint for SQL functions. Server-side logic runs as a [Function](/docs/functions).',
    ],
  },
  {
    slug: 'auth',
    title: 'Auth & Users',
    group: 'build',
    purpose: 'Sign-up and sign-in for the people who use your app.',
    summary:
      'Auth & Users lets people create an account in your app and sign in, with an email and password or a social provider. It issues the session tokens your database rules read, and lists everyone who signed up so you can reset a password or block an account.',
    metaDescription:
      'What Auth & Users does: email and password sign-up, social sign-in with your own OAuth app, project-scoped session tokens, password reset emails, and managing the people who use your app.',
    why:
      'Most apps need to know who is asking before they show or change anything. Building that yourself means password hashing, sessions, reset emails and OAuth flows, and a mistake in any of them is a security problem rather than a bug. Auth & Users gives each project its own user system, separate from your Backenly account, and your [database](/docs/database) rules use its tokens to decide which rows each person can see.',
    examples: [
      'Customers sign up with an email and password, and reset a forgotten password by email.',
      'Visitors sign in with Google or GitHub through your own OAuth app.',
      'A user reports a problem, and you find their account, send a password reset or block it.',
      'A B2B product gives each customer company its own organization, with members and roles.',
    ],
    how: [
      {
        title: 'Your agent turns it on',
        body: 'Email and password sign-up becomes active when your agent adds it, or when the first person signs up from your app.',
      },
      {
        title: 'People sign up from your app',
        body: 'Through the SDK or `/api/v1/{projectId}/auth/*`. Passwords are hashed with bcrypt, and identities live in your project’s own schema.',
      },
      {
        title: 'Each session is a signed token',
        body: 'Signed with your project’s own secret, never Backenly’s. Your app sends it as `X-User-Token`, and every row-level security policy reads it.',
      },
      {
        title: 'You manage people in the console',
        body: 'The Users tab lists everyone who signed up. Signing out revokes a session on the server, and a blocked user cannot sign in.',
      },
    ],
    prompts: [
      'Add email and password sign-up and sign-in to my app, with password reset by email.',
      'Add organizations with members and roles, so each company only sees its own data.',
    ],
    code: {
      label: 'From your app',
      language: 'js',
      code: `await backend.auth.signUp({ email, password })
await backend.auth.signIn({ email, password })

// From here on the SDK sends the user's token,
// so your row-level security rules apply.`,
    },
    notes: [
      'The people who use your app and your own Backenly account are two separate systems. They share no tables and no tokens.',
      'Google and GitHub sign-in can be set up in the console, and your agent can also add Discord or Facebook. Each uses your own OAuth app, and its secret is stored encrypted for the project.',
      'Verification, password reset and magic link emails can go out through your own SMTP server with your own templates. A test send in the console confirms the settings actually deliver.',
      'The `users` table is managed here and is never served at `/db/users`, because it holds password hashes.',
    ],
  },
  {
    slug: 'storage',
    title: 'Storage',
    group: 'build',
    purpose: 'Files your app works with, like photos, PDFs and videos.',
    summary:
      'Storage keeps the files your app works with: profile photos, receipts, PDFs, videos. The database stores the record, Storage stores the file it points to, and files are private unless you make them public.',
    metaDescription:
      'What Storage does and why an app needs it: buckets for user uploads, private files with expiring links, public files with stable URLs, image resizing, and file-type rules.',
    why:
      'A database is built for rows of text and numbers, not for a 4 MB photo or a 200-page PDF. Putting files in tables makes every query slower and every backup larger. Storage gives files their own home, organised in buckets, and your database keeps only each file’s path. Private files are read through links that expire, so a file meant for one person does not end up public.',
    examples: [
      'A user uploads a profile photo. The app stores it in an avatars bucket and saves its path on the user’s profile row.',
      'A shop shows product photos to every visitor from a public bucket.',
      'An invoicing app keeps PDFs private and gives each customer a download link that expires.',
      'A marketplace converts uploaded photos to WebP at a fixed width so pages load faster.',
    ],
    how: [
      {
        title: 'Your agent creates a bucket',
        body: 'A bucket is a folder with its own rules. It is private unless you make it public, and it can limit which file types it accepts.',
      },
      {
        title: 'Your app uploads the file',
        body: 'From the browser or a server, through the SDK or `/api/v1/{projectId}/storage/upload`. Images can be resized and converted to WebP, JPEG or PNG on the way in.',
      },
      {
        title: 'Backenly checks it',
        body: 'Executable files are refused, and so is a file whose declared type does not match its extension.',
      },
      {
        title: 'Your app reads it back',
        body: 'A public file has a stable URL. A private file is read through a signed link that expires.',
      },
    ],
    prompts: [
      'Create a private avatars bucket that only accepts images, and store each user’s photo path on their profile.',
      'Create a public bucket for the product photos in the shop’s catalogue.',
    ],
    code: {
      label: 'From your app',
      language: 'js',
      code: `const { path, url } = await backend.storage.upload(file, \`avatars/\${userId}.jpg\`, {
  bucket: 'avatars',
  format: 'webp',
  width: 512,
})`,
    },
    notes: [
      'Uploads come from your app. Your agent manages buckets and links, but does not upload files itself.',
      'Deleting a file or a bucket from your agent waits for a person to approve it in the console.',
      'How much you can store depends on your plan. See [Pricing](/pricing).',
    ],
  },
  {
    slug: 'functions',
    title: 'Functions',
    group: 'build',
    purpose: 'Your own server-side code, run on an event, a schedule or an HTTP call.',
    summary:
      'Functions run your own code on Backenly’s servers instead of in the user’s browser. A function runs when something happens: a user signs up, a row changes, a schedule comes round, or your app calls its HTTP endpoint.',
    metaDescription:
      'What Functions are for: server-side code that keeps secret keys out of the browser, triggered by sign-ups, table changes, schedules or HTTP calls, with logs for every run.',
    why:
      'Some work cannot run in the browser. A Stripe secret key or an email API key would be visible to anyone who opens the developer tools, and a browser tab cannot run a job at 3 a.m. or react when another user changes a row. Functions are where that code goes. It runs on the server, reads secrets your app never sees, and starts on its own when its trigger fires.',
    examples: [
      'Send a welcome email when a user signs up.',
      'When an order is inserted, charge the card and record the payment.',
      'Every night, delete carts that were abandoned more than 30 days ago.',
      'Check a coupon code against rules your frontend should not be able to read.',
    ],
    how: [
      {
        title: 'Your agent writes the function',
        body: 'From a description, or from your own source code. A function whose code does not compile and load is never saved.',
      },
      {
        title: 'You choose what starts it',
        body: 'A user signing up; an insert, update or delete on a table (captured inside the database, so it fires no matter which door wrote the row, within about a minute); a schedule (every 15 minutes, or a 5-field cron expression); an HTTP request to `/api/v1/{projectId}/fn/{name}`; or only when you run it by hand.',
      },
      {
        title: 'It runs on the server',
        body: 'It can read encrypted environment variables you set for the project, so secret keys never reach the browser.',
      },
      {
        title: 'Every run is logged',
        body: 'The console shows each run with its result, duration, log lines and error, including the check Backenly runs when an HTTP function is created. You can test-run a function from the console before relying on it.',
      },
    ],
    prompts: [
      'When a user signs up, send them a welcome email through Resend.',
      'Every night at 2:00, delete carts older than 30 days that never became orders.',
    ],
    notes: [
      'Runs are counted per month, and the allowance depends on your plan. See [Pricing](/pricing).',
      'Turning a function off stops its trigger without deleting it. Deleting one from your agent waits for a person to approve it.',
      'There are no SQL functions (`rpc()`). Logic that would live in a stored procedure runs here instead.',
    ],
  },
  {
    slug: 'realtime',
    title: 'Realtime',
    group: 'build',
    purpose: 'Live updates in your app the moment data changes.',
    summary:
      'Realtime pushes changes to your app as they happen. When a row is inserted, updated or deleted in a table you stream, every screen subscribed to that table receives the change without refreshing.',
    metaDescription:
      'What Realtime does: live insert, update and delete events from your tables, delivered to the app over Server-Sent Events, plus presence and broadcast.',
    why:
      'Without it, an app only learns about new data when it asks again: the user refreshes, or the app polls every few seconds and spends requests on nothing. Chat, order status, live dashboards and shared lists all feel broken when they lag. Realtime turns the database’s own change notifications into a live stream, so the screen updates when the data does.',
    examples: [
      'A new chat message appears for everyone in the conversation as soon as it is sent.',
      'A customer watches an order go from paid to shipped without refreshing the page.',
      'A team dashboard updates its numbers as new rows arrive.',
      'A shared document shows who else is viewing it right now.',
    ],
    how: [
      {
        title: 'Your agent turns it on for a table',
        body: 'Realtime is per table. Backenly installs a change trigger on it, and the Realtime page lists every table that is streaming.',
      },
      {
        title: 'PostgreSQL announces each change',
        body: 'Every insert, update and delete fires a notification from inside the database, whoever made the change.',
      },
      {
        title: 'Backenly streams it to your app',
        body: 'Over Server-Sent Events, through one shared listener, so a busy project does not use up database connections. The SDK reconnects on its own after a drop.',
      },
      {
        title: 'Your app applies it',
        body: 'Your callback receives the event type and the row. The same connection also carries presence (who is online) and short broadcast messages.',
      },
    ],
    prompts: [
      'Enable realtime on the messages table so new messages appear without a refresh.',
    ],
    code: {
      label: 'From your app',
      language: 'js',
      code: `const unsubscribe = backend.realtime.subscribe('messages', (event) => {
  // event.type is 'insert', 'update' or 'delete'
  render(event)
})`,
    },
    notes: [
      'Changes made while a connection is down are not replayed. If your app needs every change, fetch the latest rows through the API after it reconnects.',
      'Realtime carries row changes, not a stream of progress. To show progress on a slow job, keep its status in a column and subscribe to that table.',
      'Presence treats a user as online for 60 seconds after their last activity. Broadcast messages are limited to 6 KB and are not stored.',
      'The number of open realtime connections depends on your plan. See [Pricing](/pricing).',
    ],
  },
  {
    slug: 'integrations',
    title: 'Integrations',
    group: 'build',
    purpose: 'Stripe, Resend, OpenAI, Anthropic and PostHog, connected with your own keys.',
    summary:
      'Integrations connect your backend to services you already use: Stripe for payments, Resend for email, OpenAI or Anthropic for AI features, and PostHog for analytics. You paste your own key once, and your agent builds the tables and functions that use it.',
    metaDescription:
      'What Integrations does: connect Stripe, Resend, OpenAI, Anthropic and PostHog with your own API keys, stored encrypted, and have your coding agent build the payments, email or AI features on top.',
    why:
      'Payments, email delivery and AI models are services you rent rather than build. Each needs a secret key that must never reach the browser, plus backend work around it: a checkout endpoint, a receiver that verifies Stripe’s webhook signature, a record of sent emails, a quota so a loop cannot drain your OpenAI credit. Integrations stores the key encrypted for the project and gives your agent a known starting point for that work.',
    examples: [
      'Sell monthly and annual plans with Stripe, and record each payment from Stripe’s signed webhooks.',
      'Send order confirmations and receipts through Resend.',
      'Generate product descriptions with OpenAI or Anthropic behind a request quota.',
      'Track sign-ups and key actions in PostHog.',
    ],
    how: [
      {
        title: 'Paste your key',
        body: 'Pick a provider and paste the API key from its dashboard. It is stored encrypted for this project, and Backenly asks the provider whether the key works where the provider allows that.',
      },
      {
        title: 'Describe what you want',
        body: 'Pick a starting point, such as subscription billing or a welcome email, and Backenly turns it into a request for your coding agent.',
      },
      {
        title: 'Your agent builds it',
        body: 'Over MCP it creates the tables, functions and webhook receivers the feature needs, through the same governed path as every other change.',
      },
      {
        title: 'Functions use the key on the server',
        body: 'Your functions call the provider through `ctx.integrations`, which uses the stored key, so the key never ships to the browser.',
      },
    ],
    prompts: [
      'Add subscription billing with Stripe: monthly and annual plans, a checkout endpoint, and a payments table updated from Stripe’s webhook.',
      'Send a welcome email through Resend when a user signs up.',
    ],
    notes: [
      'You use your own accounts with these providers and pay them directly.',
      'Stripe also needs its webhook signing secret, so Backenly can check that payment events really came from Stripe.',
      'Functions that use a key stop working if the key is removed.',
      'Integrations is for services your backend calls. To tell your own services that something changed, use [Webhooks](/docs/webhooks).',
    ],
  },

  // ── Operate ────────────────────────────────────────────────────────────────
  {
    slug: 'autonomy',
    title: 'Autonomy',
    group: 'operate',
    purpose: 'What Backenly fixes on its own, and what waits for your approval.',
    summary:
      'Autonomy keeps checking your backend after your agent’s session ends. It finds problems such as a missing index or a table without row-level security, fixes the safe ones on its own if you allow it, and holds everything else for your approval.',
    metaDescription:
      'What Autonomy does: checks the running backend every minute, fixes safe and reversible problems on its own in Autopilot, holds risky changes in a review queue, and keeps restore points.',
    why:
      'A backend keeps changing after launch: new tables, more traffic, a column someone added by hand. Problems show up when nobody is looking, and the usual answer is a person on call. Autonomy takes the first part of that job. It checks every minute, shows the evidence for what it finds, and never applies a change it cannot undo without asking you first.',
    examples: [
      'A foreign key with no index starts slowing a page down. Autonomy adds the index and records what it did.',
      'A new table holds user data without row-level security. Autonomy flags it and shows you why.',
      'Your agent asks to drop a table. The request waits in the review queue until you approve or reject it.',
      'A change went wrong, and you roll the backend back to a saved restore point.',
    ],
    how: [
      {
        title: 'It checks every minute',
        body: 'On every plan, Free included. The checks look for schema drift, missing indexes, slow queries, gaps in row-level security, broken triggers and stuck deployments. A check that cannot run is reported as not checked, never as passing.',
      },
      {
        title: 'It sorts fixes by risk',
        body: 'Additive, reversible fixes are the safe band. Auth changes, credentials, anything destructive and anything irreversible always wait for a person.',
      },
      {
        title: 'You choose the mode',
        body: 'Review-only holds every visible change for your one-click approval; silent additive repairs (indexes, API definitions) still apply. Autopilot applies safe fixes on its own and still holds the rest.',
      },
      {
        title: 'Everything leaves a record',
        body: 'Each fix shows what was found, what changed and how it was checked. Restore points roll tables, columns, APIs, storage buckets and base auth back to a saved version.',
      },
    ],
    prompts: [
      'What is waiting for my approval in Backenly, and why?',
      'Show me the open health findings in my backend, with their evidence.',
    ],
    notes: [
      'No mode can apply auth, destructive or irreversible changes on its own. That floor is not a setting.',
      'Routine checks and safe repairs are deterministic and use no AI credits. When those checks cannot explain a finding, an AI investigation can gather read-only evidence and suggest a typed repair. Its explanation is labelled as a hypothesis, and any proposed repair waits for a person’s approval. On Cloud, Backenly pays for these investigations.',
      'A project with no traffic, no changes and no other activity for 30 days is not checked until activity returns.',
      'Rolling back to a restore point keeps anything added since. OAuth providers and functions have to be reconnected by hand.',
    ],
  },
  {
    slug: 'monitoring',
    title: 'Monitoring',
    group: 'operate',
    purpose: 'Traffic, speed and errors of the running backend.',
    summary:
      'Monitoring shows how your backend is behaving: how many requests it serves, how fast it answers and how often it fails. It breaks the numbers down by endpoint and keeps a searchable log of every request.',
    metaDescription:
      'What Monitoring shows: request volume, latency, success rate and reliability, per-endpoint p95 latency and error rates, system events, and a searchable request log.',
    why:
      'When a user says the app is slow or broken, you need to know whether the backend agrees: which endpoint, since when, and with what error. Without monitoring that means guessing, or adding logging after the fact and waiting for it to happen again. Monitoring records it from the first request, so the evidence is already there when you need it.',
    examples: [
      'A user reports a failed checkout. You filter the log to that endpoint and find the error.',
      'After a change, you check that nothing got slower.',
      'You look at which endpoints get the most traffic before deciding what to optimise.',
      'Your agent reads recent errors over MCP and works on the endpoint that is failing.',
    ],
    how: [
      {
        title: 'Every request is recorded',
        body: 'The runtime logs each API request it serves: method, path, status, latency and time.',
      },
      {
        title: 'The numbers come from that log',
        body: 'Average latency, request count, success rate (no 4xx or 5xx) and reliability (no 5xx), over the time range you pick.',
      },
      {
        title: 'Each endpoint gets its own view',
        body: 'Traffic, p95 latency and error rate per endpoint, so a slow or failing route stands out.',
      },
      {
        title: 'System events sit beside the log',
        body: 'Deploys, incidents and significant changes appear next to the charts. Unusual behaviour is the autonomy loop’s job: problems that need a decision surface on Autonomy.',
      },
    ],
    prompts: ['Is anything in my backend failing right now? Show me the errors grouped by endpoint.'],
    notes: [
      'Monitoring shows what happened. Deciding what to do about it happens in [Autonomy](/docs/autonomy), so the two never give different answers about the same problem.',
      'A new project shows nothing until something calls its API.',
    ],
  },
  {
    slug: 'branches',
    title: 'Branches',
    tag: 'Beta',
    group: 'operate',
    purpose: 'A separate copy of your backend to try changes on first.',
    summary:
      'Branches give your agent its own copy of your backend’s schema to build against, the way a pull request lets you try code before merging it. Production keeps serving while the branch changes, and merging replays the changes onto production.',
    metaDescription:
      'What Branches are for: an isolated copy of your schema where a coding agent can build and test a change, compare it with production, and merge it back or throw it away.',
    why:
      'Changing a live backend is risky: a new column or table can break the app your users have open right now. A branch lets your agent try the change somewhere that cannot affect them, test it against its own preview endpoint, and show you the difference before anything reaches production.',
    examples: [
      'Your agent builds a coupons feature on a branch and tests it before it touches the live shop.',
      'You compare a branch with production to see exactly which tables and columns changed.',
      'An experiment did not work out. You discard the branch and production never saw it.',
      'A preview build of your frontend talks to the branch through a key bound to that branch.',
    ],
    how: [
      {
        title: 'Create a branch',
        body: 'Backenly copies your schema into its own isolated space, with the same row-level security and its own id sequences. It starts empty unless you choose to copy the data too.',
      },
      {
        title: 'Your agent changes the branch',
        body: 'It passes the branch id to `apply_migration` and tests against the branch’s preview endpoint while production keeps serving.',
      },
      {
        title: 'Review the difference',
        body: 'The branch shows a schema diff against production, and warns you if production has changed since the branch was created.',
      },
      {
        title: 'Merge or discard',
        body: 'Merging replays the branch’s schema changes onto production, in order, after your approval. Discarding drops the copy and leaves production untouched.',
      },
    ],
    prompts: [
      'Create a preview branch called coupons, add a coupons table on it, and show me the diff against production.',
    ],
    notes: [
      'Branches are in beta and available on Backenly Cloud.',
      'Discarding a branch deletes its copy and every row in it. It cannot be undone.',
    ],
  },
  {
    slug: 'deploy',
    title: 'Deploy',
    group: 'operate',
    purpose: 'Publish numbered versions of your backend, and roll back to an earlier one.',
    summary:
      'Deploy is where you publish your backend. Publishing runs readiness checks first, then records the backend as a numbered version and marks the project live. On Pro and higher you can roll back to an earlier published version.',
    metaDescription:
      'What Deploy does: readiness checks before you publish, numbered versions of your backend, the history of what went live, and rollback to an earlier version.',
    why:
      'Deploy is the checkpoint between building and calling something finished. Readiness checks catch problems before you sign off, such as a table without row-level security, a webhook without a signing secret, or a behaviour check that failed. Every publish is kept as a version, so you have a history of what went live and when, and a way back to an earlier one.',
    examples: [
      'Before launch, you open Deploy and clear the blockers the readiness check found.',
      'You publish a new version after adding payments.',
      'A published version caused a problem, so you roll back to the one before it.',
      'Your agent asks to publish. The request waits for your approval, then runs exactly as asked.',
    ],
    how: [
      {
        title: 'Readiness checks run first',
        body: 'A blocker stops the publish and a warning does not. A refused publish names its blockers in the refusal.',
      },
      {
        title: 'Publish',
        body: 'The first publish takes the project from private to live as v1. Each later publish adds the next version.',
      },
      {
        title: 'Versions are kept',
        body: 'The Deploy page lists every published version, which one is current, and which ones you can roll back to.',
      },
      {
        title: 'Roll back if you need to',
        body: 'Pick an earlier version to mark it current in the history. This is bookkeeping: the live schema and data are unchanged. To restore structure, use the Database page schema History or a Snapshot.',
      },
    ],
    prompts: ['Is my backend ready to publish? List anything that is blocking it.'],
    notes: [
      'Your API answers before you publish, so you can build and test against it straight away. Publishing records a version; it does not switch the API on.',
      'Deploy publishes your backend. Your frontend is hosted wherever you choose and calls the API.',
      'When your agent asks to publish or roll back, the request waits for your approval in the console and then runs exactly as asked.',
      'Rollback is included in Pro and higher. See [Pricing](/pricing).',
    ],
  },

  // ── Connect ────────────────────────────────────────────────────────────────
  {
    slug: 'connect',
    title: 'Connect',
    tag: 'MCP',
    group: 'connect',
    purpose: 'Connect your coding agent over MCP, and your app over the API.',
    summary:
      'Connect is how things reach your backend. Your coding agent connects over MCP with a scoped key and builds through it. Your app connects through the REST API or the SDK, and tools such as psql can connect to PostgreSQL directly.',
    metaDescription:
      'How to connect Claude Code, Cursor, Codex or another coding agent to Backenly over MCP with a scoped key, and how your app and database tools connect directly.',
    why:
      'Backenly has no chat box for building. The agent you already use, such as Claude Code, Cursor or Codex, is how you build: it reads your live schema, makes changes through governed tools and shows you the results. Connect gives it the one command and the scoped key it needs. The same page holds what your frontend and other tools need: the API address, generated types and database credentials.',
    examples: [
      'You add Backenly to Claude Code with one command and start a new conversation.',
      'A contractor’s agent gets a read-only key that can inspect the project and change nothing.',
      'You generate TypeScript types for your tables so your frontend code matches the schema.',
      'You export a full `pg_dump` to keep a copy of your data outside Backenly.',
    ],
    how: [
      {
        title: 'Create a scoped key',
        body: 'Connect → Agents creates a key for this one project. Choose read-only or read-write when you create it, because an agent cannot change its own key. A read-only key is served 16 tools instead of 23, with every write tool withheld.',
      },
      {
        title: 'Install with one command',
        body: 'Run the command for your agent before you open it: Claude Code, Cursor, Codex, Antigravity, or any other MCP client. Local runs the npm package on your machine; remote connects straight to Backenly with nothing to install.',
      },
      {
        title: 'Start a new conversation',
        body: 'Agents read their MCP settings when a conversation starts, so the tools appear in the next one. Ask for `read_backend_state` to confirm the connection.',
      },
      {
        title: 'Connect your app',
        body: 'The Direct tab has the REST base URL, TypeScript types and an OpenAPI spec, the list of origins allowed to call from a browser, and read-only or read-write PostgreSQL connection strings.',
      },
    ],
    prompts: ['Call Backenly’s read_backend_state tool and tell me what exists in this project.'],
    code: {
      label: 'Claude Code, remote',
      language: 'bash',
      code: `claude mcp add --transport http backenly https://backenly.com/api/mcp --header "x-api-key: <KEY>"`,
    },
    notes: [
      'Destructive operations, such as dropping a table, never run straight from an agent. They wait for a person in the [Autonomy](/docs/autonomy) review queue.',
      'After approval, the exact parked call runs without being reinterpreted. Poll `check_approval` until its status is final. If it fails, read `resultSummary` and check the current state before asking again, because a call can stop after applying part of its work.',
      'A key is a credential. Keep it out of your repository. Revoke agent keys you stop using, and disconnect agents you signed in from the browser, on the Agents tab; your app’s keys are revoked in [Settings](/docs/settings).',
      '`pg_dump` exports (full, schema only, or data only) restore on any PostgreSQL, so your data is never locked in.',
    ],
  },
  {
    slug: 'webhooks',
    title: 'Webhooks',
    group: 'connect',
    purpose: 'Signed events sent to your own services when data changes.',
    summary:
      'Webhooks send an HTTP request to a URL you choose when something happens in your backend: a row is inserted, updated or deleted, or a user signs up. Each request is signed, retried if it fails, and logged.',
    metaDescription:
      'What Webhooks do: signed HTTP requests to your own services when rows change or a user signs up, with HMAC signatures, automatic retries and a delivery log.',
    why:
      'Your backend is rarely the only system involved. A new order might need to reach a warehouse system, a CRM or your own server. Without webhooks those systems have to keep asking whether anything changed. With them, Backenly tells them the moment it happens, and the signature proves the request really came from your backend.',
    examples: [
      'Every new order is posted to your warehouse system.',
      'Your CRM hears about each new sign-up.',
      'A search index stays in sync as products are updated or deleted.',
      'A job on your own server starts when a new upload record is inserted.',
    ],
    how: [
      {
        title: 'Add an endpoint',
        body: 'Choose an event, `row.inserted`, `row.updated`, `row.deleted` or `auth.user.created`, and the URL to call. The signing secret is shown once.',
      },
      {
        title: 'The database captures the event',
        body: 'Row events are captured inside PostgreSQL, so they fire for every writer: the REST API, functions and the table editor alike.',
      },
      {
        title: 'Backenly sends a signed POST',
        body: '`X-Webhook-Signature` carries an HMAC-SHA256 of the raw body. Your receiver computes the same HMAC and rejects anything that does not match.',
      },
      {
        title: 'Failures are retried and logged',
        body: 'A failed delivery is retried, up to five attempts over about 35 minutes. The delivery log shows every attempt with its status code, and a failed delivery can be sent again.',
      },
    ],
    prompts: [
      // Endpoint events are project-wide — the receiver filters on data.table.
      // The old prompt promised a per-table subscription the endpoint model
      // cannot express.
      'Send a signed webhook to https://example.com/hooks/rows whenever a row is inserted in this project. My receiver filters on data.table.',
    ],
    code: {
      label: 'Verify a delivery (Node.js)',
      language: 'js',
      code: `import crypto from 'node:crypto'

// rawBody: the exact bytes received, before any JSON parsing.
export function isFromBackenly(rawBody, signatureHeader, secret) {
  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(signatureHeader ?? '')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}`,
    },
    notes: [
      'Delivery is at least once. `X-Webhook-Delivery` stays the same when a retry re-sends an event, so use it to discard duplicates.',
      'Send test makes a real signed request and shows what your receiver answered.',
      'The `users` table has no row events. Use `auth.user.created` for sign-ups; its payload never includes the password hash.',
      'Webhooks tell your own services about changes. To call a provider such as Stripe or Resend from your backend, use [Integrations](/docs/integrations).',
    ],
  },

  // ── Project ────────────────────────────────────────────────────────────────
  {
    slug: 'settings',
    title: 'Settings',
    group: 'project',
    purpose: 'Project details, API keys, and who has access.',
    summary:
      'Settings holds the project’s details, its API keys and its access list. It is where you find the project id and API address, create and revoke keys, and see who can open the project.',
    metaDescription:
      'What project Settings covers: the project id and API base URL, API keys with Admin, Write, Read only and Client roles, revoking keys, and who can open the project.',
    why:
      'Every app that talks to your backend needs a key, and different callers need different powers: a browser should never hold a key that can administer the project. Settings is the one place keys are created, scoped and revoked, next to the identifiers your code needs and the controls for the project as a whole.',
    examples: [
      'You copy the project id and API base URL into your frontend’s environment variables.',
      'You create a Client key for the browser and an Admin key for a server-side job.',
      'A key leaked, so you revoke it. Anything using it stops working immediately.',
      'Before sharing data with a teammate, you check who can open the project.',
    ],
    how: [
      {
        title: 'General',
        body: 'The project’s name and description, its id, the API base URL, the region it runs in, and deleting the project.',
      },
      {
        title: 'API keys',
        body: 'Each key has a role: Admin for server-side code only, Write to read and change data, Read only, or Client for frontend apps. Every key for the project is listed here, including keys created for coding agents.',
      },
      {
        title: 'Access',
        body: 'Who can open the project comes from your organization’s members. The Access tab shows them, and you manage members from the organization’s Members page.',
      },
    ],
    prompts: ['List my project’s API keys and when each one was last used.'],
    notes: [
      'A key is shown once, when you create it. Backenly stores only a hash, so a lost key cannot be recovered: create a new one and revoke the old one.',
      'Revoking a key takes effect immediately, for every app and script using it.',
      'Deleting a project is permanent.',
    ],
  },
]

export const DOCS_BY_SLUG: Record<DocSlug, DocSection> = Object.fromEntries(
  DOC_SECTIONS.map((d) => [d.slug, d]),
) as Record<DocSlug, DocSection>

/** Sections in one group, in console order. */
export function docsInGroup(group: DocGroupId): DocSection[] {
  return DOC_SECTIONS.filter((d) => d.group === group)
}

/**
 * Where the section sits in the console sidebar, as a reader would find it:
 * "Build › Storage", but plain "Connect" where the item shares its group's
 * name, and plain "Settings", which has no group heading in the console.
 */
export function consolePath(doc: DocSection): string {
  const group = DOC_GROUPS.find((g) => g.id === doc.group)
  if (!group || !group.inConsole || group.label === doc.title) return doc.title
  return `${group.label} › ${doc.title}`
}
