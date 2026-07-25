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
  apiKey: process.env.BACKENLY_API_KEY!,
})

const { data, error } = await backend.from('posts').select().eq('published', true).order('created_at', { ascending: false })
```

## Auth

End-user accounts (the users of *your* app), not your Backenly login.

```ts
const { data } = await backend.auth.signUp({ email, password })
await backend.auth.signIn({ email, password })
const me = await backend.auth.getUser()
await backend.auth.signOut()
```

Every request after `signIn` carries the end-user's JWT automatically. The wire
format is two headers — `Authorization: Bearer <apiKey>` identifies the
*project*, `X-User-Token: <jwt>` identifies the *end-user*. Row-level security
policies read the second one. If you are writing a client by hand instead of
using this SDK, see the [REST reference](https://backenly.com/llms.txt) — the
two-header scheme is documented there and is not guessable.

## Realtime

```ts
const unsubscribe = backend.realtime.onTableChange('messages', (event) => {
  console.log(event.type, event.record) // 'insert' | 'update' | 'delete'
})
```

Server-Sent Events over a shared `LISTEN/NOTIFY` hub. Auto-reconnects with
backoff. No WebSocket dependency.

## Storage

```ts
const { data } = await backend.storage.from('avatars').upload(`${userId}.png`, file)
const url = await backend.storage.from('avatars').getSignedUrl(`${userId}.png`, 3600)
```

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
const rows = await backend.from('posts').select() // fully typed
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
