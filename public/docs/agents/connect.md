# Keys, env and connections

Index: https://backenly.com/llms.txt

## One project per connection

Every key and OAuth connection is bound to exactly one project, which is what keeps a leaked credential's reach to that project. `connect { action: "whoami" }` says which project and which key you are acting as; check it before changing anything when more than one project is in play. To work on another project, re-point the connection (`npx @backenly/cli link --project <id> --key <key>`, or Connect in that project's dashboard). Creating a project is done in the dashboard, because no project credential can act on the account.

## Actions

<!-- generated:actions:connect by scripts/generate-agent-docs.ts from lib/mcp/domains.ts; do not edit -->
Call as `connect { action: "<action>", … }`.

| Action | What it does | Needs | Read-only key | Approval |
| --- | --- | --- | --- | --- |
| `whoami` | the project this connection is bound to, and the key or OAuth connection calling | nothing | yes | no |
| `create_api_key` | a scoped key for an app, optionally bound to a preview branch | nothing | no | no |
| `list_api_keys` | every key with its scope and last use | nothing | yes | no |
| `set_key_permissions` | change what a key may do | `keyId`, `permissions` | no | no |
| `revoke_api_key` | disable a key (apps using it stop working) | `keyId` | no | waits for a human |
| `set_env` | an encrypted variable functions read as ctx.env.KEY | `key`, `value` | no | no |
| `list_env` | variable names with 4-character previews | nothing | yes | no |
| `delete_env` | remove a variable | `key` | no | waits for a human |
| `database_credentials` | a Postgres connection string (read-write only after a human arms it) | nothing | no | no |
| `connect_frontend` | allow a frontend origin (CORS) | `url` | no | no |
| `disconnect_frontend` | remove a frontend origin | `url` | no | waits for a human |
| `list_apps` | the frontends connected to this backend | nothing | yes | no |
<!-- end generated -->

## Keys

`create_api_key` returns the new key once. By default it is a publishable key: safe in a browser, it reads only what row-level security lets anonymous callers read and writes nothing without an end-user's `X-User-Token`. `serviceRole: true` makes a secret key that bypasses row-level security entirely, for servers only; one sent from a browser is refused. To rotate with no downtime, create the new key, move the app to it, then revoke the old one (`revoke_api_key` waits for a human). MCP keys for agents are issued in the dashboard only, by design, and read-only is chosen there.

## Environment variables

`set_env { key, value }` stores an encrypted variable that sandbox functions read as `ctx.env.KEY`. Keys are `UPPER_SNAKE_CASE`. Use it for values the app needs; provider keys go in `integrations`, and Backenly's own secrets are never settable here.

## Database credentials

`database_credentials` issues a read-only Postgres role on demand, and a read-write role only after a human arms it in the dashboard. See `database`.
