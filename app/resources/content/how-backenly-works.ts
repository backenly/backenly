import type { ArticleData } from './types'

export const article: ArticleData = {
  slug: 'how-backenly-works',
  title: 'How Backenly works',
  metaDescription:
    'The path a change takes from your agent to your database: intent planning, one governed mutation kernel, PostgREST as the data plane, behavioural verification, and a closed autonomy loop. What each layer is responsible for.',
  lane: 'mechanism',
  category: 'Architecture',
  answers: 'What actually happens between my agent and my database?',
  datePublished: '2026-08-29',
  dateModified: '2026-08-29',
  dateDisplay: 'Updated August 29, 2026',
  intro:
    'Backenly is four layers with one rule between them: nothing mutates structure except through a single typed kernel. That constraint is what makes a change reviewable, reversible, and safe for an agent to make. This page walks the path a change takes and names what each layer owns — including the parts that are deliberately not automatic.',
  sections: [
    {
      heading: 'The path of one change',
      blocks: [
        {
          kind: 'steps',
          steps: [
            {
              label: '1',
              title: 'Your agent, over MCP',
              body: 'A scoped key, a manifest of 20 tools, and a request. Either a specific tool like `apply_migration`, or plain English through `backend_chat`.',
            },
            {
              label: '2',
              title: 'Planning turns intent into typed actions',
              body: 'A classifier routes the turn — build, modify, fix, destructive, question — and a planner derives entities, relations, columns, and policies. The output is a plan of discrete actions, not SQL text handed to the database.',
            },
            {
              label: '3',
              title: 'The kernel applies it',
              body: '`executeAction` is the only path that mutates structure. Every action is validated, audited, and applied all-or-nothing, and schema-mutating actions snapshot the schema before they run so the change can be rolled back to a saved version. An operation outside the vocabulary does not run.',
            },
            {
              label: '4',
              title: 'PostgreSQL takes the write',
              body: 'Into that project\'s own schema. Grants and row-level security are installed as part of the same change, not as a follow-up someone has to remember.',
            },
            {
              label: '5',
              title: 'Verification exercises the result',
              body: 'Real HTTP against the live runtime: CRUD lifecycle, auth flow, two-user isolation. Evidence comes back with the result.',
            },
            {
              label: '6',
              title: 'The autonomy loop takes over',
              body: 'From here the change is something the loop monitors, and something you can revert.',
            },
          ],
        },
      ],
    },
    {
      heading: 'Why there is no raw-SQL mutation path',
      blocks: [
        {
          kind: 'p',
          text: 'A language model asked to run twenty interdependent DDL statements will get most of them right. The failure is not dramatic — step fourteen names a column slightly differently than step three assumed, and you get a backend that looks correct and breaks at runtime. Retrying with a better prompt does not fix a class of error that comes from unbounded execution.',
        },
        {
          kind: 'p',
          text: 'So the model plans and the platform executes. `apply_migration` accepts ordinary PostgreSQL DDL and translates it into typed actions; anything it cannot map is refused with the route forward rather than silently dropped. The consequence is a real constraint, and worth stating plainly: operations outside the vocabulary are not available, and a patch that writes DDL around the kernel is rejected in this codebase no matter how correct the SQL is.',
        },
        {
          kind: 'p',
          text: 'What you get for that constraint is that the agent\'s model of the database and the database itself cannot silently diverge, and every change — from you, from your agent, or from an automated repair — arrives through the same audited door.',
        },
      ],
    },
    {
      heading: 'The data plane',
      blocks: [
        {
          kind: 'p',
          text: 'Tables are served by PostgREST, reading the PostgreSQL catalog directly. There is no API registry to keep in sync: `/db/<table>` is live the moment the table exists, which is why there is no "generate API" step in the tool surface. Authorization is Postgres grants plus row-level security, so an embedded resource is subject to the same privileges as a direct read.',
        },
        {
          kind: 'p',
          text: 'One consequence is a shape you should expect: requests PostgREST cannot model — nested paths beyond the supported depth, `/search`, `/bulk` — return 404 rather than degrading into something with different semantics. A 404 there is the contract telling you where the boundary is.',
        },
      ],
    },
    {
      heading: 'Two processes',
      blocks: [
        {
          kind: 'p',
          text: 'A Backenly deployment is two Node processes behind a reverse proxy, against a PostgreSQL instance:',
        },
        {
          kind: 'table',
          columns: ['Process', 'Serves'],
          rows: [
            ['Next.js', 'The dashboard and the platform APIs a developer calls'],
            ['Express runtime', 'The public end-user API at /api/v1/*, plus realtime, presence, and broadcast'],
          ],
        },
        {
          kind: 'p',
          text: 'The split matters for a reason that is easy to miss: your app\'s end-users and your Backenly account are two completely isolated auth systems. Platform sessions are signed with the deployment secret; end-user sessions are signed with your project\'s own secret and live in your project\'s schema. They share no tables and no JWTs. An end-user of your app has no relationship to Backenly at all.',
        },
      ],
    },
    {
      heading: 'The autonomy loop',
      blocks: [
        {
          kind: 'p',
          text: 'After a change lands, a closed monitor-analyze-plan-execute loop keeps watching. It observes telemetry, runs probes for schema drift, missing indexes, slow queries, RLS gaps, broken triggers, and stuck deployments, and proposes fixes in the same typed vocabulary the agent uses.',
        },
        {
          kind: 'p',
          text: 'It runs no language model. That is a design property with two visible consequences: it draws no AI credits on any plan, and it can be run at a one-minute cadence for everyone rather than rationed as a paid feature.',
        },
        {
          kind: 'p',
          text: 'The loop applies only the reversible safe band. Auth changes, external credentials, destructive operations, and anything irreversible always wait for a human — that floor is not a setting. What the loop applies on its own is snapshotted before the fix and revertible afterward. The operations guide covers the dial, the review queue, and the activity gate that decides which projects get a pass.',
        },
        {
          kind: 'note',
          text: 'One detector depends on a server-level PostgreSQL setting. Without `pg_stat_statements`, the measured slow-query check reports itself UNCHECKED rather than passing — an empty result is indistinguishable from a healthy backend, and treating it as green is how a dead detector once read healthy for months.',
        },
      ],
    },
    {
      heading: 'What the platform will not do for you',
      blocks: [
        {
          kind: 'responsibility',
          platform: [
            'Plans, applies, audits, verifies, and can reverse structural change.',
            'Serves and authorizes the data plane through PostgreSQL itself.',
            'Monitors the running backend and repairs the reversible safe band.',
            'Keeps your data portable: direct Postgres credentials on request, full pg_dump any time.',
          ],
          you: [
            'Decide what the product should do. The loop fixes operational problems, not product problems.',
            'Approve anything destructive, credential-bearing, or irreversible.',
            'Own your frontend, your business logic, and your data model.',
            'On self-hosting: the servers, the Postgres, the OpenAI key, and the upgrade cadence.',
          ],
        },
        {
          kind: 'p',
          text: 'The honest summary of what this replaces: not the work of deciding what to build, and not the code your agent is good at writing. It replaces the operator — the person who would otherwise own the migration, the policy, the monitoring, and the 3 a.m. page.',
        },
      ],
    },
  ],
  conclusion:
    'One kernel for every structural change, PostgREST reading the catalog for every read, PostgreSQL enforcing every authorization decision, and a loop that keeps checking after your session ends. The constraint that makes it work — no raw-SQL mutation path — is also the thing to weigh before you adopt it.',
  relatedSlugs: ['the-data-api', 'after-you-launch', 'self-hosting'],
}
