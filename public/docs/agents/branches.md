# Branches

Index: https://backenly.com/llms.txt

Preview branches, on Backenly Cloud: a copy of the project's schema in an isolated PostgreSQL schema, for testing an app against it while production keeps serving. Schema changes made with `apply_migration` and the other build tools still apply to the main schema, not to a branch.

`branch { action }`:

- `list`: every branch and its state.
- `create`: a new branch. It starts **empty**: the schema is copied with its row-level security and its own sequences, the rows are not, unless you pass `includeData: true`.
- `diff`: what differs between the branch and the main schema.
- `merge`: create the branch's new tables on the main schema. Added columns, type changes and drops come back as review items.

Discarding a branch goes through `backend_chat` and waits for a human's approval.

## Pointing an app at a branch

A key bound to a branch (`connect` `create_api_key` with `branchId`) is the branch's endpoint: the same base URL, `https://backenly.com/api/v1/{projectId}`, with that key. The environment comes from the key; no header or URL switches it.

- The key reads and writes the branch through the data API: `/api/v1/{projectId}/db/*` and `/api/v2/{projectId}/*`.
- Every data API response carries `X-Backenly-Environment`: `branch:<name>` for a branch, `main` otherwise. Check it in a test to confirm you are not reading production.
- Every other endpoint (end-user auth, functions, storage, realtime) refuses a branch key with `BRANCH_SURFACE_UNAVAILABLE` (403), because it would be served from production.
- When the branch is merged or discarded, the key is refused with `BRANCH_INACTIVE` rather than falling back to the main schema.
