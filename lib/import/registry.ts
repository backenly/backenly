/**
 * Which driver moves which source. Firebase loads lazily, so a fault in one
 * driver's module never stops the others from loading.
 */

import type { ImportSourceId } from './contract'
import type { ImportDriver } from './driver'

export async function driverFor(source: ImportSourceId): Promise<ImportDriver | null> {
  switch (source) {
    case 'supabase':
      return (await import('./drivers/supabase')).supabaseDriver as ImportDriver
    case 'postgres':
      return (await import('./drivers/postgres')).postgresDriver as ImportDriver
    case 'firebase':
      return (await import('./drivers/firebase')).firebaseDriver as ImportDriver
    default:
      return null
  }
}

/** The source's name in a sentence. */
export function sourceName(source: ImportSourceId): string {
  return source === 'supabase' ? 'Supabase' : source === 'firebase' ? 'Firebase' : 'Postgres'
}
