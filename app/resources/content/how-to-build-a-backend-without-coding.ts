import type { ArticleData } from './types'

export const article: ArticleData = {
  slug: 'how-to-build-a-backend-without-coding',
  title: 'How to Build a Backend Without Coding: A Complete Walkthrough',
  metaDescription:
    'A step-by-step walkthrough of building a production backend without writing backend code: describing your data model, generating tables and APIs, connecting a frontend with the SDK, handling auth, and changing the schema safely after launch.',
  category: 'Guide',
  readTime: '11 min read',
  datePublished: '2026-05-11',
  dateModified: '2026-07-18',
  dateDisplay: 'Updated July 18, 2026',
  intro:
    'A walkthrough of building a backend without writing backend code, using a real example: a task management app. It covers describing the data model, connecting a frontend, authentication, changing the schema after there is live data in the tables, and what happens when you ask for something destructive. Every code snippet is the SDK\'s actual surface, and every behavior described is what the platform does today — including where it stops and asks before proceeding.',
  sections: [
    {
      heading: 'Step 0: Connect an agent — that is where you type',
      blocks: [
        {
          kind: 'p',
          text: 'On Backenly, you build by describing what you want in plain English to an AI agent connected to your project over MCP (the Model Context Protocol). That agent can be Claude Code or Cursor if you work in an editor — or Claude Desktop, which is a plain chat app, if you don\'t. The setup is one command and one key:',
        },
        {
          kind: 'code',
          language: 'bash',
          label: 'One-time setup',
          code: `npx @backenly/mcp-server init
# paste the mcp_live_… key from your project's MCP tab
# ✓ Verified. Connected to your project.`,
        },
        {
          kind: 'p',
          text: 'From here on, "tell Backenly" means typing into that conversation. The agent relays your request to the platform; the platform plans, executes, and reports back. The dashboard at backenly.com is where you inspect the result — tables, data, monitoring, approvals — not where you type build requests.',
        },
      ],
    },
    {
      heading: 'Step 1: Write the description like a brief, not a wish',
      blocks: [
        {
          kind: 'p',
          text: 'The single highest-leverage skill in this workflow is writing a description that contains decisions. Compare "I need a backend for my task app" with this:',
        },
        {
          kind: 'code',
          language: 'text',
          label: 'A description that contains decisions',
          code: `I'm building a task management app. Users sign up with email.
Users create projects. Each project has multiple tasks.
Tasks have a title, description, status (todo / in progress / done),
and a due date. Users can only see their own projects and tasks.`,
        },
        {
          kind: 'p',
          text: 'That second version specifies the entities (users, projects, tasks), the relationships (users own projects, projects contain tasks), the fields with their types (status is an enum with three values, due date is a date), and the access rule (strict per-user isolation). You do not need to know that "users can only see their own projects" becomes a row-level security policy in PostgreSQL — but because you said it, it will. Anything you leave out gets a sensible default; anything you state gets built as stated.',
        },
        {
          kind: 'p',
          text: 'For a build like this, Backenly replies with its plan — the tables, columns, relations, and policies it intends to create — before anything runs. Read it. This is the moment to say "tasks also need a priority field" rather than discovering the gap later. Confirm in the conversation, and the platform executes the plan as governed steps: schema first, then APIs, then auth, then policies, then a verification pass that exercises the real endpoints over HTTP.',
        },
      ],
    },
    {
      heading: 'Step 2: Read the verification, not the success message',
      blocks: [
        {
          kind: 'p',
          text: 'When the build finishes, Backenly does something most tools skip: it proves the backend works instead of telling you it does. It creates a real test user through the real signup endpoint, runs create/read/update/delete against the generated APIs over live HTTP, and — the important one — signs in as a second user and confirms they get zero rows of the first user\'s data. That last check is your "users can only see their own projects" sentence, tested behaviorally rather than assumed.',
        },
        {
          kind: 'p',
          text: 'Each check comes back with its evidence — in the agent\'s reply and in the activity journal on your project\'s Overview page. If one fails, you see the failure. Get in the habit of reading the isolation check on any backend that holds private user data: it is the check that matters most, and the one that usually doesn\'t exist in hand-rolled backends.',
        },
      ],
    },
    {
      heading: 'Step 3: Connect your frontend with the SDK',
      blocks: [
        {
          kind: 'p',
          text: 'Your backend is now a standard REST API with a JavaScript SDK. It works with React, Vue, Next.js, Svelte, mobile web — anything that can make HTTP requests. The SDK gives every table a typed client with the same five operations plus counting and relations:',
        },
        {
          kind: 'code',
          language: 'js',
          label: 'The full CRUD surface, per table',
          code: `import { createClient } from '@backenly/sdk'
const backend = createClient({ projectId, apiKey })

// Create
const task = await backend.tasks.create({
  title: 'Ship onboarding flow',
  status: 'todo',
  due_date: '2026-08-01',
})

// List with filters, ordering, pagination
const open = await backend.tasks.list({
  where: { status: 'todo' },
  orderBy: 'due_date',
  order: 'asc',
  limit: 25,
})

// Read one, update, delete
const t = await backend.tasks.get(task.id)
await backend.tasks.update(task.id, { status: 'in progress' })
await backend.tasks.delete(task.id)

// Count without fetching
const remaining = await backend.tasks.count({ status: 'todo' })

// Fetch relations in one request (foreign keys were inferred at build time)
const projects = await backend.projects.list({ include: ['tasks'] })`,
        },
        {
          kind: 'p',
          text: 'If your frontend lives in Cursor or Claude Code, the MCP connection from Step 0 already gives that agent the live schema to write against — it never has to invent mock data. For any other frontend, the Connect page has the hosted SDK snippet with your project ID and public key inlined: paste it in and the code above works against your real tables, auth, and API contracts.',
        },
      ],
    },
    {
      heading: 'Step 4: Authentication is already done — use it',
      blocks: [
        {
          kind: 'p',
          text: 'The backend generated a complete auth system scoped to your project: signup, signin, JWT sessions signed with your project\'s own secret (isolated from every other Backenly project), plus email verification, magic links, and Google sign-in if you enable them. From the frontend:',
        },
        {
          kind: 'code',
          language: 'js',
          label: 'End-user auth from the frontend',
          code: `// Sign a user up — creates a row in YOUR project's users table
await backend.auth.signUp({ email, password })

// Sign in — the SDK stores the session and sends the JWT automatically
await backend.auth.signIn({ email, password })

// Every request after this is authenticated. Combined with the
// row-level security from your description, this list is already
// scoped to the signed-in user — no filtering code needed:
const myProjects = await backend.projects.list()`,
        },
        {
          kind: 'p',
          text: 'The detail that matters: access control lives in the database, not in your frontend code. You never write "filter tasks by current user" logic, which means you can never forget it on one screen and leak data. This is the class of bug that takes down early products, and it is structurally absent here.',
        },
      ],
    },
    {
      heading: 'Step 5: Change the schema after launch — the real test',
      blocks: [
        {
          kind: 'p',
          text: 'Any generator can build tables on day one. The test of an operating platform is week six, when your tables have live rows and the change you need touches them. Say the app now needs comments:',
        },
        {
          kind: 'code',
          language: 'text',
          label: 'Iterating in plain English',
          code: `Add a comments table. Each task can have multiple comments.
Each comment has a body and belongs to a user.`,
        },
        {
          kind: 'p',
          text: 'Backenly plans the change against your live backend — new table, two foreign keys, CRUD APIs, and security policies consistent with the ones you already have — applies it as governed steps, and verifies. Additive changes like this run without ceremony. Destructive ones don\'t: ask it to "drop the projects table, I don\'t need it anymore" and the operation stops. The reply states exactly what is affected, including the live row count, and whether the data is recoverable; nothing runs until you explicitly confirm, and a restore point is captured first so the backend\'s structure can be rolled back to a saved version.',
        },
        {
          kind: 'note',
          text: 'This is the property to demand from any tool that touches your production data: destructive operations must be impossible to trigger by accident, and every change must have a way back. "The AI is usually right" is not an operational guarantee.',
        },
      ],
    },
    {
      heading: 'Step 6: Go live, and let the platform keep watching',
      blocks: [
        {
          kind: 'p',
          text: 'Deploying is a sentence ("put it live") with two gates in front of it: the platform runs a readiness check and reports blockers and warnings, then asks for explicit confirmation before anything becomes publicly callable. Deployments are versioned, and Pro can roll back to a previous one. After launch, the autonomy loop monitors your real traffic — requests, latency, error rates — every minute on every plan. What happens when it detects a problem is up to the autonomy level you set: at the cautious end, every proposed fix waits in the review queue for your approval; further up the dial, low-risk repairs are applied automatically and written up afterward with what was detected, what changed, and how the fix was verified.',
        },
        {
          kind: 'p',
          text: 'Realtime is included when you need it — your frontend can subscribe to live database changes over Server-Sent Events without running any socket infrastructure:',
        },
        {
          kind: 'code',
          language: 'js',
          label: 'Live updates without a socket server',
          code: `const unsubscribe = backend.realtime.subscribe('tasks', (event) => {
  // event.type: 'insert' | 'update' | 'delete' — event.data holds the row
  refreshTaskList(event)
})`,
        },
      ],
    },
    {
      heading: 'What this approach is not good for',
      blocks: [
        {
          kind: 'p',
          text: 'A described backend is the right tool when your product is a recognizable shape: users, content, relations, permissions, files, payments, notifications — which covers most software products. It is the wrong tool if your core product is the backend itself: a database engine, a trading system with microsecond latency budgets, a system whose regulatory constraints require owning every line. Backenly does support custom logic through functions (run code on insert, update, or delete, on signup, on a schedule, or over HTTP) — but if your business logic is hundreds of interlocking rules, you will want engineers involved, with the platform handling the infrastructure underneath them. That is how the Enterprise tier is typically used.',
        },
      ],
    },
  ],
  conclusion:
    'Building a backend without writing backend code is possible in 2026 — as real infrastructure, not a prototype: PostgreSQL, REST, JWT auth, and database-enforced access control, verified behaviorally after every build. The workflow: connect an agent over MCP, write a description that contains decisions, read the plan before confirming it, let the platform execute and verify, connect your frontend through the hosted SDK, then keep iterating in plain English while the platform guards the dangerous edges — explicit confirmation for destructive changes, restore points for schema changes, and a monitoring loop that keeps watching after you ship. Start on the free plan and judge it by the verification evidence, not the promises.',
  relatedSlugs: ['what-is-ai-backend-generation', 'full-stack-development-with-ai-coding-agents'],
}
