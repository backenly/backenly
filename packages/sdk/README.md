# @backenly/sdk

Official client SDK for [Backenly](https://backenly.com) — database, auth, storage and realtime for a project you built with an agent.

Ships ESM and CommonJS, with TypeScript declarations. No dependencies.

```bash
npm install @backenly/sdk
```

```ts
import { createClient } from '@backenly/sdk'

const backend = createClient({
  projectId: process.env.BACKENLY_PROJECT_ID!,
  apiKey: process.env.BACKENLY_CLIENT_KEY!,
})

const { data } = await backend.from('posts').select().eq('published', true).order('created_at', { ascending: false })
```

`apiKey` is a client (publishable) key: Settings → API keys → New key → Client
in the dashboard, or `connect { action: "create_api_key" }` from your coding
agent. It is safe in browser code and bound by your row-level security. Never
use your agent's MCP key (`mcp_live_…`) here: the API refuses it.

A request the API refuses throws a `BackenlyError` carrying the API's `code`,
`status` and message.

## Auth

End-user accounts (the users of *your* app), not your Backenly login.

```ts
const { user } = await backend.auth.signUp({ email, password }) // and signed in
await backend.auth.signIn({ email, password })
const me = await backend.auth.getUser() // null when nobody is signed in
await backend.auth.logout()
```

Every request after `signIn` carries the end-user's JWT automatically. The wire
format is two headers — `x-api-key: <apiKey>` identifies the
*project*, `X-User-Token: <jwt>` identifies the *end-user*. Row-level security
policies read the second one. If you are writing a client by hand instead of
using this SDK, see the [REST reference](https://backenly.com/docs/agents/client-setup.md) — the
two-header scheme is documented there and is not guessable.

## Realtime

In the browser, a table's inserts, updates and deletes as they happen:

```ts
const unsubscribe = backend.realtime.subscribe('messages', (event) => {
  if (event.type === 'insert' || event.type === 'update') console.log(event.type, event.data)
  if (event.type === 'delete') console.log('deleted', event.data) // the row's primary key
})

unsubscribe() // when the view goes away
```

`backend.messages.subscribe(callback)` is the same subscription. An event
carries the row in `data`. The callback also receives the stream's `connected`
and `error` events, so check `type` first. Inserts and updates reach a stream
only for rows its signed-in user may read. A table streams nothing until
realtime is enabled for it: ask your agent (`realtime { action: "enable" }`).

Server-Sent Events over a shared `LISTEN/NOTIFY` hub. Auto-reconnects with
backoff. No WebSocket dependency. Outside a browser, `subscribe` does nothing.

## Storage

```ts
// `avatars` is a bucket whose policy lets files be public.
const { id } = await backend.storage.upload(file, `${userId}.png`, { bucket: 'avatars', isPublic: true })
avatar.src = backend.storage.getUrl(id) // the file itself, served to anyone

await backend.storage.delete(id)
```

`upload(file, path, options)` resolves with the file's `id`, `path`, `size`,
`contentType` and `url`. A named bucket must exist already: create one in the
dashboard or ask your agent. Without `bucket`, the file goes to the project's
private `default` bucket. `isPublic: true` makes a file public when its
bucket's policy allows public files (`public_read` or `cdn_cacheable`).

`getUrl(id)` is the address a file is served at. A public file is served there
to anyone, so the address works as an `<img src>`. Any other file is served
there only to a reader its bucket's policy allows. For one of those, the `url`
that `upload()` resolved is a signed link that works for an hour. An
`owner_only` bucket refuses links: its files are read only by the end user who
uploaded them.

`delete(id)` removes a file. Only the end user who uploaded it, or a
service-role key, may.

## Migrating from supabase-js

A compatibility shim maps the supabase-js surface onto Backenly, so an existing
frontend moves by changing the import and the constructor call:

```ts
import { createClient } from '@backenly/sdk/supabase'

const supabase = createClient('https://backenly.com/api/v1/<PROJECT_ID>', '<BACKENLY_ANON_KEY>')
```

`.from().select().eq()`, `.or()`, embedded resources (`select('*, author(*)')`),
`.overlaps()`, `upsert(..., { onConflict })`, `auth.signInWithPassword` and
channel subscriptions all work. The `{ data, error }` contract is preserved and
nothing throws.

## Typed clients

```bash
npx @backenly/cli types > src/backenly.types.ts
```

Or, from an agent with MCP configured, call `generate_types`.

```ts
import { createTypedClient } from '@backenly/sdk'
import type { Database } from './backenly.types'

const backend = createTypedClient<Database>({ projectId, apiKey })
const posts = await backend.posts.list({ where: { published: true } }) // PostsRow[]
```

## Browser use without an API key

In the browser `apiKey` may be omitted: the SDK fetches the project's public
anon key via `GET /api/v1/{projectId}/bootstrap` before the first authenticated
request. Pass it explicitly in Node and SSR.

## Also available from a CDN

For a plain HTML page with no build step:

```html
<script src="https://backenly.com/backenly-sdk.js"></script>
<script>
  const backend = createClient({ projectId: '...', apiKey: '...' })
</script>
```

Prefer the npm package everywhere else — a CDN URL cannot be typechecked,
lockfiled, or bundled, and breaks under SSR.

## License

MIT
