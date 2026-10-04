# Branches

Index: https://backenly.com/llms.txt

Preview branches, on Backenly Cloud: a copy of the project's schema in an isolated PostgreSQL schema, for testing an app against it while production keeps serving. Schema changes made with `apply_migration` and the other build tools still apply to the main schema, not to a branch.

`branch { action }`:

- `list`: every branch and its state.
- `create`: a new branch, returned with its preview endpoint and a client key. It starts **empty**: the schema is copied with its row-level security and its own sequences, the rows are not, unless you pass `includeData: true`.
- `connect`: another key for an active branch, with its preview endpoint. `serviceRole: true` issues a server-side key that bypasses row-level security on the branch only.
- `diff`: what differs between the branch and the main schema.
- `merge`: create the branch's new tables on the main schema. Added columns, type changes and drops come back as review items.

Discarding a branch goes through `backend_chat` and waits for a human's approval.

## The preview endpoint

A branch has no separate host. Its endpoint is the project's usual base URL, `https://backenly.com/api/v1/{projectId}`, with a key bound to the branch: the environment comes from the key, and no header or URL switches it. Branch keys start with `proj_preview_` (or `svc_preview_`), so a key in an app's environment shows which one it talks to.

- The key reads and writes the branch through the data API: `/api/v1/{projectId}/db/*` and `/api/v2/{projectId}/*`.
- Every data API response carries `X-Backenly-Environment`: `branch:<name>` for a branch, `main` otherwise. Assert it in tests, so a test can never pass by reading production.
- Every other endpoint (end-user auth, functions, storage, realtime) refuses a branch key with `BRANCH_SURFACE_UNAVAILABLE` (403), because it would be served from production.
- With the SDK, pass `apiKey` explicitly. Without one, the SDK fetches the project's public anon key, which is a production key.
- The branch's OpenAPI spec: `GET /api/cli/types?format=openapi&branch={branchId}` with your MCP key.
- The branch's own traffic: `monitoring` `request_logs` with its `branchId`. Production's monitoring never counts it.
- When the branch is merged or discarded, the key is refused with `BRANCH_INACTIVE` rather than falling back to the main schema.
