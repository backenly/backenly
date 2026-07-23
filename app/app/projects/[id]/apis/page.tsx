/**
 * /apis → /database
 *
 * The APIs page listed a "generated REST contract" drawn from ApiDefinition
 * rows. That made sense when ApiDefinition WAS the exposure decision — the
 * legacy executor served only tables that had one, so the list was real state
 * you managed.
 *
 * It stopped being true when the PostgreSQL catalog became the source of truth.
 * The page then rendered a projection as if it were authoritative, and it drifted:
 * it advertised GET/POST/PATCH/DELETE on `_email_verifications`, a table the
 * runtime 404s and Postgres has revoked. A developer — or an agent — reading it
 * as the contract would call endpoints that cannot exist.
 *
 * PostgREST-backed platforms have no such page for the same reason: under
 * PostgREST the API *is* the schema. `GET /posts` exists because the table exists. There is
 * no registry to browse, because the endpoint list and the table list are one
 * list. So the tables page is the API page.
 *
 * A redirect rather than a 404: links live in bookmarks, docs and agent memory,
 * and this codebase already redirects removed sections (/review-queue, ?hub=)
 * instead of breaking them.
 */

import { redirect } from 'next/navigation'

export default function ApisPage({ params }: { params: { id: string } }) {
  redirect(`/app/projects/${params.id}/database`)
}
