import type { ArticleData } from './types'

export const article: ArticleData = {
  slug: 'the-data-api',
  title: 'The data API',
  metaDescription:
    'Backenly serves your tables through PostgREST behind two grammars: a stable REST contract and PostgREST native. The two authentication headers, the SDK surface, generated types, and the paths that 404 on purpose.',
  lane: 'mechanism',
  category: 'Reference',
  answers: 'What exactly can my frontend call, and how does it authenticate?',
  datePublished: '2026-08-29',
  dateModified: '2026-08-29',
  dateDisplay: 'Updated August 29, 2026',
  intro:
    'Every table in a project is served over HTTP the moment it exists. There is no API registry to keep in sync and no generation step, because the API is resolved from the PostgreSQL catalog per request. This is the contract: two grammars over one engine, two headers that do different jobs, and a short list of things that deliberately return 404.',
  sections: [
    {
      heading: 'One engine, two grammars',
      blocks: [
        {
          kind: 'p',
          text: 'The data plane is PostgREST. Backenly exposes it through two surfaces because they answer different needs, and both hit the same rows through the same authorization path.',
        },
        {
          kind: 'table',
          columns: ['Surface', 'Shape', 'Use it when'],
          rows: [
            [
              '/api/v1/{projectId}/db/{table}',
              'GET list · POST create · GET /{id} · PATCH /{id} · DELETE /{id}, with filtering, sorting, pagination and a stable response envelope',
              'You want a contract that will not move under you, or you are using the SDK',
            ],
            [
              '/api/v2/{projectId}/{table}',
              "PostgREST's grammar passed through untouched: ?price=gte.100, ?or=(a.eq.1,b.eq.2), ?order=createdAt.desc, ?select=*,author(*)",
              'You already know PostgREST or Supabase, or you need embeds, OR-filters, and exact counts',
            ],
          ],
        },
        {
          kind: 'p',
          text: 'Embedded resources are the reason to reach for v2. `?select=*,author(*)` returns a post and its author in one round trip, and the embed is subject to the same database privileges as a direct read — a `?select=*,users(*)` is refused by Postgres itself, not by a check somebody remembered to write.',
        },
        {
          kind: 'p',
          text: 'On the v1 surface, any query parameter that is not a control is read as an equality filter on that column. The controls are fixed, and anything with an unrecognised shape is dropped rather than passed through — so a typo cannot turn into a live predicate:',
        },
        {
          kind: 'table',
          columns: ['Control', 'Effect'],
          rows: [
            ['limit, offset, page, cursor', 'Pagination. Limit defaults to 50 and caps at 1,000.'],
            ['sort, order', 'Ordering — `?sort=createdAt&order=desc`. On v2 this is `?order=createdAt.desc` instead.'],
            ['select', 'Column projection.'],
            ['include', 'Related rows, followed from real foreign keys.'],
            ['include_deleted', 'Soft-deleted rows are hidden by default. Only `include_deleted=true` lifts that.'],
          ],
        },
        {
          kind: 'note',
          text: 'Soft delete is a Backenly convention, not a PostgREST one, so the `deleted_at IS NULL` predicate is re-applied on every read by the translation layer. This matters if you ever query the database directly: rows your API treats as deleted are still there, and a raw `SELECT *` will return them.',
        },
        {
          kind: 'p',
          text: 'Update and delete require a record id. `PATCH /db/posts/{id}` and `DELETE /db/posts/{id}` work; a bare `PATCH /db/posts` with a filter does not, and is refused rather than interpreted as a bulk operation.',
        },
      ],
    },
    {
      heading: 'Two headers, two different jobs',
      blocks: [
        {
          kind: 'p',
          text: 'This is the part that is not guessable, and getting it wrong produces empty results rather than errors.',
        },
        {
          kind: 'code',
          language: 'bash',
          label: 'A read as a signed-in end-user',
          code: `curl "https://backenly.com/api/v1/$PROJECT_ID/db/tasks?status=todo" \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "X-User-Token: $END_USER_JWT"`,
        },
        {
          kind: 'list',
          items: [
            '`Authorization: Bearer <apiKey>` identifies the project. Required on every request.',
            '`X-User-Token: <end-user JWT>` identifies the end-user, and is what row-level security reads. Omit it and the request runs unauthenticated.',
          ],
        },
        {
          kind: 'note',
          text: 'An unauthenticated request against an RLS-protected table returns an empty result set, not a 403. That is correct behaviour — the policy filters rows rather than rejecting the caller — but it means a missing `X-User-Token` looks exactly like "no data yet". If a list is unexpectedly empty, check the header before you check the data.',
        },
      ],
    },
    {
      heading: 'The SDK',
      blocks: [
        {
          kind: 'p',
          text: 'The package is `@backenly/sdk` and the factory is `createClient`. ESM, CommonJS, and TypeScript declarations; no dependencies. Any property that is not a built-in module resolves to a table client, so `backend.tasks` works without codegen.',
        },
        {
          kind: 'code',
          language: 'js',
          label: 'Per-table operations',
          code: `import { createClient } from '@backenly/sdk'
const backend = createClient({ projectId, apiKey })

await backend.tasks.list({ where: { status: 'todo' }, orderBy: 'createdAt', order: 'desc', limit: 25 })
await backend.tasks.get(id)
await backend.tasks.create({ title: 'Ship it' })
await backend.tasks.update(id, { status: 'done' })
await backend.tasks.delete(id)
await backend.tasks.count({ status: 'todo' })

// Related rows in one request, following the table's foreign keys.
// Has-many attaches as an array; belongs-to attaches as a single object.
await backend.projects.list({ include: ['tasks'] })`,
        },
        {
          kind: 'p',
          text: 'Relations are resolved from real foreign keys in your schema, never guessed from the string you pass, and every related load runs under the same user context as a direct query — a row you cannot read directly is not readable through an include either. Two ceilings apply: includes nest two levels deep, and a single relation loads at most 1,000 related rows per request, so a has-many on a large child table cannot quietly become an export.',
        },
        {
          kind: 'p',
          text: 'For anything the object form cannot express there is a query builder with `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in`, `isNull`, `isNotNull`, and `search`. Auth, storage, realtime, presence, and broadcast are modules on the same client.',
        },
        {
          kind: 'code',
          language: 'js',
          label: 'The other modules',
          code: `await backend.auth.signUp({ email, password })
await backend.auth.signIn({ email, password })

await backend.storage.upload(file, 'photos/hero.jpg', { bucket: 'images' })

const unsub = backend.realtime.subscribe('tasks', (event) => {
  // event.type: 'insert' | 'update' | 'delete'
  applyChange(event)
})`,
        },
        {
          kind: 'p',
          text: 'In the browser you can omit `apiKey`. The client fetches the project\'s public anon key from a bootstrap handshake before the first authenticated request, and `request()` awaits it, so a slow handshake cannot produce a call with a missing header. Pass the key explicitly in Node or SSR.',
        },
        {
          kind: 'p',
          text: 'There are CDN bundles at `backenly.com/backenly-sdk.js` and `backenly-sdk.esm.js`. Use them only for a plain HTML page with no build step — a CDN URL cannot be typechecked, lockfiled, or bundled, and it breaks under SSR.',
        },
      ],
    },
    {
      heading: 'Types that cannot drift',
      blocks: [
        {
          kind: 'p',
          text: 'Row types written by hand go stale on the next migration, silently. Generate them from the live catalog instead — from your agent with `generate_types`, or from the CLI:',
        },
        {
          kind: 'code',
          language: 'bash',
          label: 'CLI',
          code: `npx @backenly/cli link          # associate this directory with a project
npx @backenly/cli schema        # tables and the foreign-key graph
npx @backenly/cli types --client # backenly.types.ts + a typed client
npx @backenly/cli openapi       # export an OpenAPI spec
npx @backenly/cli query         # read-only SQL console
npx @backenly/cli logs --follow
npx @backenly/cli diff          # exits 1 when committed types drift from the live schema`,
        },
        {
          kind: 'p',
          text: '`diff` is the one worth wiring into CI. It turns "someone changed the schema and nobody regenerated" from a runtime surprise into a failed build. `generate_types` carries a schema hash, so you can also tell whether a regeneration actually changed anything.',
        },
      ],
    },
    {
      heading: 'Realtime',
      blocks: [
        {
          kind: 'p',
          text: 'Change events come off PostgreSQL\'s own `LISTEN`/`NOTIFY` and reach the browser over Server-Sent Events, through a shared listener hub so a busy project does not exhaust Postgres connections. No WebSocket server, no Redis. The connection reconnects on drop with exponential backoff.',
        },
        {
          kind: 'p',
          text: 'If you are not using the SDK, note that `EventSource` cannot send headers, so the credential has to travel in the URL. Request a short-lived single-use ticket rather than putting a JWT there — the ticket is valid for 30 seconds and one connection, so what lands in access logs is already spent:',
        },
        {
          kind: 'code',
          language: 'bash',
          label: 'Ticketed SSE',
          code: `POST /api/v1/{projectId}/realtime/ticket
  Authorization: Bearer <apiKey>
  X-User-Token:  <end-user JWT>
  → { ticket, expiresIn }

GET  /api/v1/{projectId}/realtime/subscribe?table=tasks&ticket=<ticket>
  Accept: text/event-stream`,
        },
        {
          kind: 'p',
          text: 'The legacy `?apiKey=&userToken=` form still works for existing clients and is deprecated. Presence uses the same transport with a 60-second activity window; broadcast is ephemeral pub/sub with a 6 KB payload limit. Tickets are signed with the project\'s own secret, so a project that has not enabled end-user auth yet cannot issue one.',
        },
        {
          kind: 'note',
          text: 'Realtime carries row change events. It is not a token stream — if you are showing progress for a slow job, make the job status a column and subscribe to changes on that row.',
        },
      ],
    },
    {
      heading: 'What returns 404 on purpose',
      blocks: [
        {
          kind: 'list',
          items: [
            '`/db/users` — that table holds password hashes and is reached only through `/auth/*`. A project whose only table is `users` correctly reports zero exposed resources.',
            '`/search`, `/bulk`, and deeper nested paths — shapes PostgREST cannot model. They 404 rather than quietly degrading into something with different semantics.',
            '`rpc()` — Backenly exposes no SQL functions by design. Custom logic runs as a function attached to an event, a schedule, or an HTTP endpoint.',
          ],
        },
        {
          kind: 'responsibility',
          platform: [
            'Resolves endpoints from the PostgreSQL catalog, so a table created a second ago is queryable.',
            'Enforces authorization with Postgres grants and row-level security, including through embeds.',
            'Redacts password, token, and API-key columns from read-only SQL results.',
            'Keeps the v1 contract stable while v2 tracks PostgREST.',
          ],
          you: [
            'Send `X-User-Token` when a request should run as an end-user.',
            'Regenerate types after a schema change, or let `diff` fail your build.',
            'Keep your project API key out of untrusted clients — use the public anon key in browsers.',
            'Choose a grammar per call site and stay consistent within a codebase.',
          ],
        },
      ],
    },
    {
      heading: 'Coming from Supabase',
      blocks: [
        {
          kind: 'p',
          text: 'A frontend written against supabase-js keeps working. `@backenly/sdk/supabase` is a compatibility entry point built directly on the v2 surface, so it emits PostgREST rather than translating to a narrower dialect — which means `.or()`, `select(\'*, author(*)\')` embeds, `.overlaps()`, `upsert(values, { onConflict })`, and `count: \'exact\'` all behave. Every operation resolves `{ data, error }` and never throws, and `channel().on(\'postgres_changes\', …)` maps onto Backenly realtime.',
        },
        {
          kind: 'p',
          text: 'The one refusal is `rpc()`, and it is a real platform boundary rather than a gap in the shim.',
        },
      ],
    },
  ],
  conclusion:
    'One PostgREST engine, a stable v1 contract and a native v2 grammar on top of it, and authorization enforced by the database on both. Send the project key to identify the app and the user token to identify the person, generate your types instead of writing them, and treat the 404s as the contract telling you where a boundary is.',
  relatedSlugs: ['access-control-and-rls', 'your-first-backend', 'how-backenly-works'],
}
