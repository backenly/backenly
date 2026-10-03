# Branches

Index: https://backenly.com/llms.txt

Preview branches, on Backenly Cloud: a copy of the project's schema to change and test before merging the change back.

`branch { action }`:

- `list`: every branch and its state.
- `create`: a new branch. It starts **empty**: the schema is copied with its row-level security and its own sequences, the rows are not, unless you pass `includeData: true`.
- `diff`: what differs between the branch and the main schema.
- `merge`: apply the branch's changes to the main schema.

Discarding a branch goes through `backend_chat` and waits for a human's approval.

A key can be bound to a branch; its requests then read and write the branch. When the branch is merged or discarded, that key is refused with `BRANCH_INACTIVE` rather than falling back to the main schema.
