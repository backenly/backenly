import type { ArticleData } from './types'

export const article: ArticleData = {
  slug: 'your-first-backend',
  title: 'Your first backend',
  metaDescription:
    'The build loop on Backenly: describe the backend, read the plan, let the governed executor apply it, and read the verification evidence. What gets created, what the checks actually assert, and how to change a schema that already has rows in it.',
  lane: 'start',
  category: 'Guide',
  answers: 'What happens between describing a backend and having one?',
  datePublished: '2026-08-29',
  dateModified: '2026-08-29',
  dateDisplay: 'Updated August 29, 2026',
  intro:
    'Once your agent is connected, you build by describing what the product does. This walks the loop end to end on a task app: the description, the plan, what the executor writes, what the post-build checks assert, and what happens the first time you ask for something destructive. Every behaviour here is what the platform does today, including where it stops and asks.',
  sections: [
    {
      heading: 'Write a description that contains decisions',
      blocks: [
        {
          kind: 'p',
          text: 'The highest-leverage thing you do in this workflow is decide things in the description. Compare "I need a backend for my task app" with:',
        },
        {
          kind: 'code',
          language: 'text',
          label: 'A description with decisions in it',
          code: `A task manager. Users sign up with email.
Users create projects. Each project has many tasks.
A task has a title, a description, a status of
todo / in_progress / done, and a due date.
Users can only see their own projects and tasks.`,
        },
        {
          kind: 'p',
          text: 'That names the entities, the relationships, the field types, the permitted status values, and the access rule. You do not need to know that the last line becomes a row-level security policy — but because you wrote it, it becomes one. What you leave out gets a default; what you state gets built as stated.',
        },
        {
          kind: 'p',
          text: 'You can also skip the prose and hand your agent SQL. `apply_migration` takes ordinary PostgreSQL DDL — `CREATE TABLE`, `ALTER TABLE ADD COLUMN` / `RENAME COLUMN` / `ADD CONSTRAINT` / `ALTER COLUMN SET`|`DROP NOT NULL`, `CREATE [UNIQUE] INDEX` — multiple statements, semicolon-separated. Your DDL is applied as written: declared `NOT NULL`, `DEFAULT`, and nullability are honoured exactly.',
        },
      ],
    },
    {
      heading: 'What actually runs',
      blocks: [
        {
          kind: 'steps',
          steps: [
            {
              label: 'Input',
              title: 'Your description, or DDL',
              body: 'Reaches the platform through `backend_chat` or `apply_migration` over MCP.',
            },
            {
              label: 'Plan',
              title: 'Intent becomes typed actions',
              body: 'A planner derives entities, relations, columns and policies, then compiles them into a sequence of governed actions. The model never writes SQL directly into your database — it produces a plan the executor runs.',
            },
            {
              label: 'Apply',
              title: 'One kernel, all-or-nothing',
              body: 'Every mutation goes through `executeAction`, whether it came from you, your agent, or an automated repair. Schema-mutating actions — creating a table, adding, dropping or renaming a column, adding a constraint or index, enabling auth, vector search or teams — snapshot the schema before they run, so the change can be rolled back to a saved version. An operation the parser cannot map is refused with the route forward, never silently dropped.',
            },
            {
              label: 'Verify',
              title: 'The backend is exercised, not assumed',
              body: 'Checks run against the live runtime over real HTTP and return their evidence with the result.',
            },
            {
              label: 'Output',
              title: 'A schema, endpoints, auth, and policies',
              body: 'Tables in your project\'s own PostgreSQL schema, REST endpoints resolved from the catalog, project-scoped JWT auth, and row-level security enforced in the database.',
            },
          ],
        },
        {
          kind: 'p',
          text: 'Three columns are provisioned for you on every table Backenly creates, and their naming is a known wart rather than a rule you can infer: `id` (uuid primary key), `"createdAt"` and `"updatedAt"` (camelCase, timestamptz), and `"deleted_at"` (snake_case, soft delete). Order by `createdAt`, filter soft deletes on `deleted_at`, quote the camelCase identifiers in raw SQL — unquoted they fold to lowercase and will not resolve. Declaring any of the three yourself is skipped and reported. Columns you declare exist exactly as you wrote them.',
        },
        {
          kind: 'note',
          text: 'There is no API generation step to wait for. `/db/<table>` is live the moment the table exists, resolved from the PostgreSQL catalog per request. The one exception is `users`, which is managed through `/auth/*` and never exposed as `/db/users`, because it holds password hashes.',
        },
      ],
    },
    {
      heading: 'Read the verification, not the success message',
      blocks: [
        {
          kind: 'p',
          text: 'The common failure mode of generated infrastructure is the confident lie: the system reports success and the backend does not work. After a build, Backenly runs checks against the live runtime and returns each one with its evidence, into your agent\'s reply and into the project\'s activity journal.',
        },
        {
          kind: 'table',
          columns: ['Check', 'What it asserts'],
          rows: [
            ['CRUD lifecycle', 'create → read → update → delete, then a post-delete read returns nothing'],
            ['Auth flow', 'signup → token issuance → JWT verification → protected resource access'],
            ['RLS two-user isolation', 'user A inserts a row; user B is signed in and sees none of it'],
            ['Live HTTP endpoints', 'signup → JWT → GET list → POST create, over real HTTP rather than in-process'],
            ['Trigger / function execution', 'a database event fires and the function\'s last-run timestamp advances'],
            ['Webhook HMAC', 'an invalid signature is rejected with 401'],
          ],
        },
        {
          kind: 'p',
          text: 'The isolation check is the one to read on any backend holding private data. It is behavioural: a second user is created and signed in, and the assertion is that they receive zero rows — not that the policy text looks right. A wrong policy does not fail loudly on its own; it quietly shows one user another user\'s data.',
        },
        {
          kind: 'p',
          text: 'Checks that do not apply are reported as skipped, and a skip is never counted as a pass. If verification cannot run at all, the reply says so rather than implying it passed.',
        },
      ],
    },
    {
      heading: 'Connect a frontend',
      blocks: [
        {
          kind: 'p',
          text: 'What you have now is a standard REST API. The SDK is one install and a factory call:',
        },
        {
          kind: 'code',
          language: 'js',
          label: 'The per-table surface',
          code: `import { createClient } from '@backenly/sdk'
const backend = createClient({ projectId, apiKey })

await backend.auth.signUp({ email, password })
await backend.auth.signIn({ email, password })

const open = await backend.tasks.list({
  where: { status: 'todo' },
  orderBy: 'due_date',
  order: 'asc',
  limit: 25,
})

const task = await backend.tasks.create({ title: 'Ship onboarding', status: 'todo' })
await backend.tasks.update(task.id, { status: 'in_progress' })
await backend.tasks.delete(task.id)

const remaining = await backend.tasks.count({ status: 'todo' })`,
        },
        {
          kind: 'p',
          text: 'Because access control lives in the database, that `list` call is already scoped to the signed-in user. You never write "filter tasks by current user" logic, which means you cannot forget it on one screen. The full contract — both query grammars, the two authentication headers, and where the SDK is the wrong tool — is in the data API guide.',
        },
      ],
    },
    {
      heading: 'Changing a schema that has rows in it',
      blocks: [
        {
          kind: 'p',
          text: 'Creating tables on an empty project is the easy half. The test is week six, when the change touches live data. Additive changes run without ceremony:',
        },
        {
          kind: 'code',
          language: 'text',
          label: 'Iterating',
          code: `Add a comments table. Each task can have many comments.
A comment has a body and belongs to a user.`,
        },
        {
          kind: 'p',
          text: 'Destructive ones do not. Ask to drop a table and the operation stops before anything runs. Over MCP it never even reaches a tool — destructive operations are absent from the advertised surface — so it is parked in the Review Queue with an approval id, and the dashboard card names the target, the live row count where it can be read, and whether the data is recoverable. A confirmation replays the exact stored call rather than re-deriving it from your words, and it expires: fifteen minutes for a named confirmation, two minutes for a bare "yes", so a forgotten approval cannot fire the next morning.',
        },
        {
          kind: 'responsibility',
          platform: [
            'Plans the change against the live schema and applies it through one governed kernel.',
            'Captures a pre-migration snapshot before creating a table.',
            'Runs the verification checks and reports each result with its evidence.',
            'Refuses to execute a destructive operation without an explicit human confirmation.',
          ],
          you: [
            'Read the plan before confirming it — that is the moment to add the field you forgot.',
            'Read the isolation check on anything holding private data.',
            'Decide whether a destructive change should happen at all.',
            'Own your frontend, your product decisions, and your data model\'s correctness.',
          ],
        },
      ],
    },
    {
      heading: 'Where this is the wrong tool',
      blocks: [
        {
          kind: 'p',
          text: 'A described backend fits when your product has a recognisable shape: users, content, relations, permissions, files, scheduled work. It is the wrong tool when the backend is the product — a database engine, a system with microsecond latency budgets, or one whose regulation requires owning every line.',
        },
        {
          kind: 'p',
          text: 'There is also a hard boundary worth knowing early: Backenly exposes no SQL functions, so there is no `rpc()` surface. Custom logic runs as a function attached to an event, a schedule, or an HTTP endpoint instead. If your business logic is hundreds of interlocking rules, you want engineers writing it, with the platform handling the infrastructure underneath them.',
        },
      ],
    },
  ],
  conclusion:
    'Describe the backend with the decisions in it, read the plan, let the governed executor apply it, and judge the result by the verification evidence rather than the success message. Then keep iterating in plain English — additive changes run, destructive ones stop and ask, and every governed change is recorded.',
  relatedSlugs: ['connect-your-coding-agent', 'the-data-api', 'access-control-and-rls'],
}
