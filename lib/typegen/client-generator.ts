/**
 * CLIENT GENERATOR
 * ================
 * Produces the project-specific typed client file that developers drop into
 * their frontend repo.  It wraps BackenlyClient so that every table accessor
 * (e.g. backend.posts) carries the correct Row / Insert / Update types at
 * compile time — zero runtime overhead, pure type magic.
 */

import type { WorkspaceSchema } from './schema-reader'
import type { GeneratedTypes } from './type-generator'

export interface GeneratedClient {
  /** Save as backenly.client.ts */
  source: string
}

function toPascalCase(s: string): string {
  return s
    .replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    .replace(/^[a-z]/, c => c.toUpperCase())
}

/**
 * Generate the typed client wrapper file.
 *
 * The output re-exports a `backend` singleton typed to the project schema.
 * Developers can also call `createTypedClient()` to create additional
 * instances (e.g. a server-side instance with a service-role key).
 */
export function generateTypedClient(
  schema: WorkspaceSchema,
  types: GeneratedTypes,
  opts: {
    projectId: string
    apiUrl?: string
    /** Relative path to the types file from this client file, default './backenly.types' */
    typesImportPath?: string
  }
): GeneratedClient {
  const typesPath = opts.typesImportPath ?? './backenly.types'
  const tableNames = types.tableNames

  const tableAccessors = tableNames
    .map(t => {
      const pascal = toPascalCase(t)
      return `  ${t}: TableClient<${pascal}Row>`
    })
    .join('\n')

  const importedRowTypes = tableNames.map(t => `${toPascalCase(t)}Row`).join(', ')

  const source = `/**
 * Backenly — typed client for project ${opts.projectId}
 * Generated: ${schema.generatedAt}
 *
 * DO NOT EDIT — regenerate via:
 *   GET /api/typegen?projectId=${opts.projectId}&format=client
 *
 * Usage:
 *   import { backend } from './backenly.client'
 *   const posts = await backend.posts.list()   // posts is PostsRow[]
 *   await backend.posts.create({ title: 'Hi' }) // type-checked insert
 */

import { BackenlyClient, TableClient } from '@backenly/sdk'
import type { Database${importedRowTypes.length > 0 ? ', ' + importedRowTypes : ''} } from '${typesPath}'

// ── Typed client shape ──────────────────────────────────────────────────────

/**
 * Extends BackenlyClient so that table accessors are typed to your exact
 * schema.  auth / storage / realtime / presence are unchanged.
 */
export type TypedBackenlyClient = BackenlyClient & {
${tableAccessors}
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createTypedClient(config?: { apiUrl?: string }): TypedBackenlyClient {
  return new BackenlyClient({
    projectId: '${opts.projectId}',
    apiUrl: config?.apiUrl ?? (typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_BACKENLY_URL : undefined) ?? 'https://backenly.com',
  }) as TypedBackenlyClient
}

// ── Default singleton ─────────────────────────────────────────────────────────

/** Drop-in typed backend for your project — import this everywhere */
export const backend = createTypedClient()

export type { Database }
`

  return { source }
}
