/**
 * A preview branch's endpoint, as an app or a coding agent uses it.
 *
 * There is no separate preview host. A branch is served at the project's own
 * base URL, `{origin}/api/v1/{projectId}`, to a key bound to that branch; the
 * key is what selects the environment, never anything in the request
 * (lib/postgrest/gateway.ts explains why a header or hostname would be a
 * cross-tenant bypass). So "the preview endpoint" is three things together:
 * the base URL, a branch-bound key, and the response header that proves which
 * environment answered. This module hands out all three in one shape, so the
 * dashboard and the agent tools describe a branch identically.
 *
 * The data API and end-user sign-up, sign-in, refresh and logout are
 * branch-scoped. Every other endpoint refuses a branch key
 * (lib/branches/key-scope.ts), and the instructions below say so rather than
 * letting a test discover it as a 403.
 */

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { mintKey } from '@/lib/auth/key-prefix'
import { plaintextForStorage } from '@/lib/auth/api-key-plaintext'
import { resolvePublicBaseUrl } from '@/lib/services/public-url'
import { BRANCH_SCOPED_SURFACES, ENVIRONMENT_HEADER, environmentHeaderValue } from '@/lib/branches/key-scope'

export interface PreviewBranchRef {
  id: string
  name: string
}

export interface PreviewEndpoint {
  branchId: string
  branch: string
  /** The project's base URL; the same one production uses. */
  baseUrl: string
  /** `${baseUrl}/db/{table}`: the branch-scoped data API. */
  dataUrl: string
  /** PostgREST's own grammar, also branch-scoped. */
  v2Url: string
  /** Every data-API response carries this; a test should assert it. */
  environmentHeader: { name: typeof ENVIRONMENT_HEADER; value: string }
  /** The branch's OpenAPI spec, read with the same MCP/CLI key (x-api-key). */
  openapiUrl: string
  branchScoped: readonly string[]
}

/** The public origin, with no request to read it from (agent tools, jobs). */
export function publicOrigin(): string {
  return resolvePublicBaseUrl({ headers: new Headers() })
}

export function previewEndpoint(projectId: string, branch: PreviewBranchRef, origin = publicOrigin()): PreviewEndpoint {
  const root = origin.replace(/\/$/, '')
  const baseUrl = `${root}/api/v1/${projectId}`
  return {
    branchId: branch.id,
    branch: branch.name,
    baseUrl,
    dataUrl: `${baseUrl}/db/{table}`,
    v2Url: `${root}/api/v2/${projectId}/{table}`,
    environmentHeader: { name: ENVIRONMENT_HEADER, value: environmentHeaderValue(branch.name) },
    openapiUrl: `${root}/api/cli/types?format=openapi&branch=${branch.id}`,
    branchScoped: BRANCH_SCOPED_SURFACES,
  }
}

/** A one-request smoke test against the branch, with the key's slot named. */
export function previewCurl(endpoint: PreviewEndpoint, table = 'your_table', key = '$BACKENLY_PREVIEW_KEY'): string {
  return `curl -i "${endpoint.baseUrl}/db/${table}?limit=5" -H "x-api-key: ${key}"`
}

/**
 * The SDK, pointed at the branch. Only the key differs from production's setup.
 *
 * The guard matters: with no apiKey the SDK fetches the project's PUBLIC ANON
 * KEY from /bootstrap, which is a production key. A preview build whose env var
 * is missing would therefore talk to production without a single error.
 */
export function previewSdkSnippet(projectId: string, key = 'process.env.BACKENLY_PREVIEW_KEY'): string {
  return [
    `import { BackenlyClient } from '@backenly/sdk'`,
    ``,
    `// Same project, same URL as production. The preview key is what selects the branch.`,
    `// @backenly/sdk 0.3.1 and earlier send no key on auth.signUp / auth.signIn, so those`,
    `// two reach production; later releases send it. Check your version before testing auth.`,
    `// Without an apiKey the SDK falls back to the production anon key, so refuse to start.`,
    `const apiKey = ${key}`,
    `if (!apiKey) throw new Error('BACKENLY_PREVIEW_KEY is not set')`,
    `const backend = new BackenlyClient({ projectId: '${projectId}', apiKey })`,
  ].join('\n')
}

/**
 * What to paste into a coding agent so it tests against the branch and knows
 * where the edges are. Written to be read by a model: plain imperatives, the
 * exact header to check, and the endpoints that will refuse the key.
 */
export function previewAgentInstructions(endpoint: PreviewEndpoint, key = '$BACKENLY_PREVIEW_KEY'): string {
  return [
    `Test against the Backenly preview branch "${endpoint.branch}", not production.`,
    ``,
    `- Base URL: ${endpoint.baseUrl} (the same as production; the key selects the branch).`,
    `- Send the preview key as the x-api-key header: ${key}. Never use a production key for these tests.`,
    `- With the SDK, always pass apiKey explicitly: without one it fetches the production anon key.`,
    `- Data API: ${endpoint.dataUrl} and ${endpoint.v2Url}.`,
    `- Every data and auth response must carry ${endpoint.environmentHeader.name}: ` +
      `${endpoint.environmentHeader.value}. Fail the test if it says "main".`,
    `- End-user auth runs on the branch: POST ${endpoint.baseUrl}/auth/signup, /auth/signin, ` +
      `/auth/refresh-token and /auth/logout WITH the preview key create and check users in the branch only. ` +
      `Send the token they return as X-User-Token alongside the preview key. A production token is refused here ` +
      `(PRODUCTION_TOKEN_ON_BRANCH), and a branch token is refused on production. @backenly/sdk 0.3.1 and ` +
      `earlier send no key on auth.signUp / auth.signIn, so with those versions call the auth endpoints over HTTP.`,
    `- A branch sign-up skips production's side effects (on_signup functions, webhooks, the active-user ` +
      `count, email verification) and lists them in skippedOnBranch.`,
    `- Functions, storage, realtime and the emailed auth flows (password reset, email verification, magic ` +
      `links) are not branch-scoped: they answer 403 BRANCH_SURFACE_UNAVAILABLE to this key. Do not work ` +
      `around that with a production key.`,
    `- The branch starts empty unless production rows were copied; seed the rows each test needs.`,
    `- OpenAPI for the branch: GET ${endpoint.openapiUrl} with your Backenly MCP key as x-api-key.`,
  ].join('\n')
}

export interface MintedPreviewKey {
  key: string
  keyId: string
  keyPrefix: string
  serviceRole: boolean
}

/**
 * Issue a key bound to an ACTIVE branch of this project.
 *
 * The branch is re-read here rather than trusted: its id may come from a model
 * or a request body, and the key it produces selects a schema. A client key by
 * default, publishable and RLS-bound like any project key; a service-role key
 * only when asked, and still confined to the branch.
 *
 * The plaintext is returned once and never stored (lib/auth/api-key-plaintext).
 */
export async function mintPreviewKey(
  projectId: string,
  branchId: string,
  opts: { serviceRole?: boolean; name?: string } = {},
): Promise<{ ok: true; minted: MintedPreviewKey; branch: PreviewBranchRef } | { ok: false; error: string; code: string }> {
  const branch = await prisma.workspaceBranch.findFirst({
    where: { id: branchId, projectId, status: 'active' },
    select: { id: true, name: true },
  })
  if (!branch) {
    return { ok: false, code: 'BRANCH_NOT_FOUND', error: 'No active preview branch with that id on this project.' }
  }
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true } })
  if (!project) return { ok: false, code: 'PROJECT_NOT_FOUND', error: 'Project not found.' }

  const serviceRole = opts.serviceRole === true
  const { key } = mintKey({ serviceRole, branchId: branch.id })
  const keyPrefix = key.substring(0, 16)
  const row = await prisma.apiKey.create({
    data: {
      projectId,
      userId: project.userId,
      name: opts.name ?? `Preview: ${branch.name}${serviceRole ? ' (service role)' : ''}`,
      key: plaintextForStorage(),
      keyHash: crypto.createHash('sha256').update(key).digest('hex'),
      keyPrefix,
      keyType: 'public',
      permissions: ['read', 'write'],
      serviceRole,
      branchId: branch.id,
      role: serviceRole ? 'service' : 'client',
      // The branch, not the clock, ends this key: a merged or discarded branch
      // refuses it outright. The expiry is a backstop for a branch left open.
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    },
    select: { id: true },
  })
  return { ok: true, branch, minted: { key, keyId: row.id, keyPrefix, serviceRole } }
}
