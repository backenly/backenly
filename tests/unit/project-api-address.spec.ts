/**
 * The address a project's API is called at, in what is generated for it.
 *
 * A project outside the home region is served by its region's API service
 * (projectApiOrigin in lib/data-plane/regional.ts). Everything handed to a
 * developer or an agent has to name that address: the SDK's default is the
 * home one, so a snippet or generated client that leaves it out talks to the
 * home region. The database-backed half (the manifest, the project route, the
 * OAuth redirect URI) is in tests/integration/project-region.spec.ts and
 * project-route-response-shape.spec.ts.
 */
import { previewEndpoint, previewSdkSnippet } from '@/lib/branches/preview'
import { generateTypedClient } from '@/lib/typegen/client-generator'
import { generateHandoffAssets } from '@/lib/typegen/handoff-generator'
import { generateTypes } from '@/lib/typegen/type-generator'
import type { WorkspaceSchema } from '@/lib/typegen/schema-reader'

const PROJECT = '11111111-2222-4333-8444-555555555555'
const HOME = 'https://backenly.com'
const VIRGINIA = 'https://us-east-1.api.backenly.com'

const SCHEMA: WorkspaceSchema = {
  projectId: PROJECT,
  schemaName: `workspace_${PROJECT}`,
  generatedAt: '2026-10-16T00:00:00.000Z',
  tables: [
    {
      tableName: 'posts',
      columns: [
        {
          tableName: 'posts',
          columnName: 'id',
          dataType: 'uuid',
          udtName: 'uuid',
          isNullable: false,
          columnDefault: 'gen_random_uuid()',
          isPrimaryKey: true,
          isForeignKey: false,
        },
        {
          tableName: 'posts',
          columnName: 'title',
          dataType: 'text',
          udtName: 'text',
          isNullable: false,
          columnDefault: null,
          isPrimaryKey: false,
          isForeignKey: false,
        },
      ],
    },
  ],
}

describe('a preview branch of a project in another region', () => {
  const branch = { id: 'br_1', name: 'preview' }

  it("is served at the region's address, and its spec read from this host", () => {
    const endpoint = previewEndpoint(PROJECT, branch, HOME, VIRGINIA)
    expect(endpoint.baseUrl).toBe(`${VIRGINIA}/api/v1/${PROJECT}`)
    expect(endpoint.dataUrl).toBe(`${VIRGINIA}/api/v1/${PROJECT}/db/{table}`)
    expect(endpoint.v2Url).toBe(`${VIRGINIA}/api/v2/${PROJECT}/{table}`)
    expect(endpoint.openapiUrl.startsWith(`${HOME}/api/cli/types`)).toBe(true)
  })

  it('is unchanged for the home region', () => {
    expect(previewEndpoint(PROJECT, branch, HOME)).toEqual(previewEndpoint(PROJECT, branch, HOME, HOME))
    expect(previewEndpoint(PROJECT, branch, HOME).baseUrl).toBe(`${HOME}/api/v1/${PROJECT}`)
  })

  it('names the address in the SDK snippet only when it is not the default', () => {
    expect(previewSdkSnippet(PROJECT, undefined, VIRGINIA)).toContain(`apiUrl: '${VIRGINIA}'`)
    expect(previewSdkSnippet(PROJECT)).not.toContain('apiUrl')
  })
})

describe('code generated for a project', () => {
  const types = generateTypes(SCHEMA)

  it("defaults the typed client to the project's address", () => {
    const source = generateTypedClient(SCHEMA, types, { projectId: PROJECT, apiUrl: VIRGINIA }).source
    expect(source).toContain(`?? '${VIRGINIA}'`)
    expect(source).not.toContain(`?? 'https://backenly.com'`)
  })

  it('keeps https://backenly.com as the default when no address is given', () => {
    expect(generateTypedClient(SCHEMA, types, { projectId: PROJECT }).source).toContain(`?? 'https://backenly.com'`)
  })

  it("puts the project's address in the handoff files", () => {
    const assets = generateHandoffAssets(SCHEMA, types, PROJECT, VIRGINIA)
    const cursor = assets.find((a) => a.framework === 'cursor')!.source
    const nextjs = assets.find((a) => a.framework === 'nextjs')!.source
    expect(cursor).toContain(`${VIRGINIA}/api/v1/${PROJECT}/`)
    expect(cursor).toContain(`NEXT_PUBLIC_BACKENLY_URL=${VIRGINIA}`)
    expect(nextjs).toContain(`NEXT_PUBLIC_BACKENLY_URL=${VIRGINIA}`)
    expect(cursor).not.toContain(`https://backenly.com/api/v1/`)
  })
})
