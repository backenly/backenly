/**
 * /app/api-builder → /app
 *
 * This was 921 lines rendering the same ApiDefinition expansion the Overview
 * panel and the /apis page did: every table fanned out into seven method rows,
 * presented as a route registry you could browse and manage.
 *
 * That registry stopped being real when the PostgreSQL catalog became the
 * source of truth and `checkExposure` stopped consulting ApiDefinition. Under
 * PostgREST the API *is* the schema — `GET /posts` exists because the table
 * exists — so a separate builder describes objects that no longer decide
 * anything, and drifts from what the runtime actually serves.
 *
 * Nothing linked here except a "no project selected" fallback on the deploy
 * page, which now goes to the project list where it belonged.
 *
 * Redirect rather than 404, matching /apis, /review-queue and ?hub=: links
 * outlive the pages they pointed at, especially in agent memory.
 */

import { redirect } from 'next/navigation'

export default function ApiBuilderPage() {
  redirect('/app')
}
