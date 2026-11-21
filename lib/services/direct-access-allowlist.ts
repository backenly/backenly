/**
 * RETIRED: THE REGION'S ADDRESS ALLOWLIST FOR DIRECT POSTGRES
 * ===========================================================
 *
 * Direct Postgres connections no longer reach a region's database through an
 * endpoint that admits only listed addresses. A project with a database of its
 * own is reached through its region's connection pooler (lib/data-plane/pooler.ts,
 * services/pooler), which signs logins in with SCRAM over TLS and keeps no
 * address list, and a shared database is not reached from outside at all
 * (lib/services/direct-access.ts). So no region keeps an allowlist, and
 * nothing here talks to one.
 *
 * These two remain only because project deletion and restore
 * (lib/projects/delete.ts, lib/projects/deletion.ts) still call them. They do
 * nothing; drop the calls with this file.
 */

import type { CloudRegionId } from '@/lib/regions'

/** Retired: no region keeps an allowlist. Does nothing. */
export async function syncAllowlist(_region: CloudRegionId): Promise<void> {}

/** Retired: no region keeps an allowlist. Does nothing. */
export async function syncAllowlistForProject(_projectId: string): Promise<void> {}
