# Branches

Index: https://backenly.com/llms.txt

Preview branches, on Backenly Cloud: a copy of the project's schema in an isolated PostgreSQL schema where you build and test a change while production keeps serving. A merge, approved by a human, replays the change onto production.

`branch { action }`:

- `list`: every branch and its state.
- `create`: a new branch, returned with its preview endpoint and a client key. It starts **empty**: the schema is copied with its row-level security and its own sequences, the rows are not, unless you pass `includeData: true`.
- `connect`: another key for an active branch, with its preview endpoint. `serviceRole: true` issues a server-side key that bypasses row-level security on the branch only.
- `diff`: the migrations applied on the branch, in order (exactly what a merge replays), what they changed, and any conflict with production.
- `merge`: replay the branch's migrations onto production. **Waits for a human**: you get an approval id to poll with `check_approval`. Refused with `MERGE_CONFLICT` while production has changed a table the migrations touch. When it runs, the branch is closed and its schema dropped.

Discarding a branch goes through `backend_chat` and waits for a human's approval.

## Building on a branch

1. `branch` `create` with a name. Keep the `branchId` and the preview key it returns.
2. `apply_migration { sql, branchId }`. Same grammar and checks as on production, applied to the branch only; production is untouched. Each statement that applies is logged for the merge. Foreign keys are recorded but not enforced on a branch.
3. Seed rows with `db_insert { table, row, branchId }`, or with the preview key over the data API.
4. Test against the preview endpoint (below). Read the branch's schema with `read_backend_state { section: "schema", branchId }` and its rows with `db_query { table, branchId }`. `run_query` reads production only.
5. `branch` `diff`, then `branch` `merge`, and tell your human it is waiting for their approval.

On a project whose production is protected (the default for new Backenly Cloud projects), `apply_migration` without a `branchId`, and the schema tools inside `backend_chat`, are refused with `BRANCH_REQUIRED`: use the steps above.

## The preview endpoint

A branch has no separate host. Its endpoint is the project's usual base URL, `https://backenly.com/api/v1/{projectId}`, with a key bound to the branch: the environment comes from the key, and no header or URL switches it. Branch keys start with `proj_preview_` (or `svc_preview_`), so a key in an app's environment shows which one it talks to.

- The key reads and writes the branch through the data API: `/api/v1/{projectId}/db/*` and `/api/v2/{projectId}/*`.
- Every data API and auth response carries `X-Backenly-Environment`: `branch:<name>` for a branch, `main` otherwise. Assert it in tests, so a test can never pass by reading production.
- End-user auth runs on the branch too, see below.
- Every other endpoint (functions, storage, realtime, and the emailed auth flows) refuses a branch key with `BRANCH_SURFACE_UNAVAILABLE` (403), because it would be served from production.
- With the SDK, pass `apiKey` explicitly. Without one, the SDK fetches the project's public anon key, which is a production key.
- The branch's OpenAPI spec: `GET /api/cli/types?format=openapi&branch={branchId}` with your MCP key.
- The branch's own traffic: `monitoring` `request_logs` with its `branchId`. Production's monitoring never counts it.
- When the branch is merged or discarded, the key is refused with `BRANCH_INACTIVE` rather than falling back to the main schema.

## End-user auth on a branch

Send the preview key on `POST /api/v1/{projectId}/auth/signup`, `/auth/signin`, `/auth/refresh-token` and `/auth/logout` (and the `/auth/register`, `/auth/login` and `/auth/refresh` aliases). The user is created and checked in the branch's own `users` table; production's is untouched. Without a key, or with a main key, these endpoints run on production as always.

- The token they return works only on that branch. Send it as `X-User-Token` together with the preview key, and row-level security on the branch sees that user.
- A production token sent with the preview key is refused with `PRODUCTION_TOKEN_ON_BRANCH`. A branch token sent to production is refused with `BRANCH_TOKEN_ON_MAIN`, and one from another branch with `BRANCH_TOKEN_MISMATCH`.
- A branch sign-up does not run production's side effects: `on_signup` functions, the `auth.user.created` webhook, the monthly active-user count and email verification. The response lists them in `skippedOnBranch`. Sign-in on a branch does not ask for a verified email.
- Password reset, email verification and magic links are not branch-scoped: the emailed link is opened with no key, so it could not say which branch it belongs to.
- `@backenly/sdk` 0.3.1 and earlier send no key on `auth.signUp` and `auth.signIn`, so those two reach production. Call the endpoints over HTTP with the preview key until the app uses a later release.
