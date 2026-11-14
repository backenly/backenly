/**
 * Whether moving a project in is offered at all: the migration guide
 * (/migrate), its footer link, and the first-run move flow (/app/welcome).
 *
 * A build-time switch (NEXT_PUBLIC_*), off unless a release sets it to
 * "published", the way usage pricing waits for NEXT_PUBLIC_USAGE_PRICING
 * (lib/pricing/catalog.ts): nothing is advertised before it runs. The
 * importer behind it (lib/import/supabase-importer.ts) is switched off by
 * SUPABASE_IMPORT_ENABLED and covers Supabase tables, rows and users today;
 * app/migrate/content.ts marks every line that still needs building.
 */
export function migrationPublished(value: string | undefined = process.env.NEXT_PUBLIC_MIGRATION): boolean {
  // Read as a literal process.env.NEXT_PUBLIC_* reference: the only form Next
  // inlines into the client bundles the footer and the welcome page ship in.
  return value === 'published'
}
