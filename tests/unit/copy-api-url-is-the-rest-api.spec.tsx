/**
 * @jest-environment jsdom
 */

/**
 * THE CONSOLE HANDS OUT THE REST API, NOT THE DEPRECATED /db
 * ==========================================================
 *
 * /api/v2/{projectId}/{table} is the one REST API (production QA, #22); /db is
 * deprecated, kept for existing apps (lib/api/v1/deprecation.ts). The table
 * page's "Copy API URL" copied `${apiBaseUrl}/db/${table}`, so every app built
 * from the console started on the dialect being retired.
 *
 * Driven through the table's real actions menu. The Connect page shows the
 * REST base beside the v1 base (which auth, functions and storage still use);
 * that and the server's restBaseUrl are pinned at source level, as
 * tests/unit/api-base-url-shown.spec.tsx pins the v1 base.
 */

import fs from 'fs'
import path from 'path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const router = { push: jest.fn(), replace: jest.fn(), prefetch: jest.fn(), back: jest.fn(), refresh: jest.fn() }
jest.mock('next/navigation', () => ({ useRouter: () => router }))
jest.mock('@/lib/api/database', () => ({
  getStructure: jest.fn(async () => [{ name: 'id', type: 'uuid', nullable: false, primaryKey: true }]),
  getIndexes: jest.fn(async () => []),
  getRelationships: jest.fn(async () => []),
  getRows: jest.fn(async () => ({ data: [], pagination: { total: 0, totalPages: 1 } })),
  insertRow: jest.fn(),
  updateRow: jest.fn(),
  deleteRow: jest.fn(),
}))

import { TablePane } from '@/components/database/TablePane'

const writeText = jest.fn(async () => {})
beforeAll(() => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

describe('the table page', () => {
  it('copies the table’s URL on /api/v2', async () => {
    render(
      <TablePane
        projectId="p1"
        schema="workspace_p1"
        table={{ name: 'orders', size: '8 kB' }}
        tables={[{ name: 'orders', size: '8 kB' }]}
        canWrite={false}
        rowParam={null}
        openRow={jest.fn()}
        closeRow={jest.fn()}
        onBack={jest.fn()}
        onDeleteTable={jest.fn()}
        onOpenSchema={jest.fn()}
        onRefreshTables={jest.fn()}
        restBaseUrl="https://api.example.test/api/v2/p1"
        windowDays={null}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for table orders' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy API URL' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://api.example.test/api/v2/p1/orders'))
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining('/db/'))
  })
})

describe('where the REST base comes from', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8')

  it('is the server’s, for the project’s region, beside the v1 base', () => {
    const route = read('app', 'api', 'projects', '[id]', 'route.ts')
    expect(route).toContain("restBaseUrl: apiBaseUrl(projectId, project.region, homeOrigin, 'v2')")
  })

  it('is shown on Connect, beside the API URL auth, functions and storage still use', () => {
    const connect = read('app', 'app', 'projects', '[id]', 'connect', 'page.tsx')
    expect(connect).toContain('project?.restBaseUrl')
    expect(connect).toContain('<CopyField value={restBaseUrl} prefix="REST" label="Copy REST API URL" />')
    expect(connect).toContain('/db under the API URL is kept for existing apps.')
  })
})
