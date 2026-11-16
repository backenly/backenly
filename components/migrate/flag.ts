/**
 * Whether the migration guide is published: /migrate and its footer link.
 *
 * A build-time switch (NEXT_PUBLIC_*), off unless a release sets it to
 * "published", the way usage pricing waits for NEXT_PUBLIC_USAGE_PRICING
 * (lib/pricing/catalog.ts): nothing is advertised before it runs.
 *
 * The console's own import (the first-run question, New project's import
 * choice and /app/org/[orgId]/import, components/onboarding) is not behind
 * this switch: it is offered wherever the import API answers
 * (GET /api/import?orgId=), so it appears with the server that runs it.
 */
export function migrationPublished(value: string | undefined = process.env.NEXT_PUBLIC_MIGRATION): boolean {
  // Read as a literal process.env.NEXT_PUBLIC_* reference: the only form Next
  // inlines into the client bundles the footer ships in.
  return value === 'published'
}
