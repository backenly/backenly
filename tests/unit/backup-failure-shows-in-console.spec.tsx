/**
 * @jest-environment jsdom
 */

/**
 * A backup that fails says so on the page, and saves nothing.
 *
 * Production QA re-test, 2026-11-16, new finding N5: the backup buttons on
 * Connect → Postgres were links with `download`, so the browser saved whatever
 * the export answered. A failed export arrived as a file named database.json
 * holding the error, and the page said nothing. The buttons now fetch the
 * export, save it only when it finished, and otherwise show the server's
 * reason under the buttons.
 *
 * A large export starts downloading while pg_dump is still running, and the
 * server cuts the connection if pg_dump then fails
 * (lib/services/database-export.ts). So a download is saved only when it ends
 * with the line the server writes after pg_dump has finished.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

jest.mock('@cloud/control-plane', () => ({ CLOUD_CONTROL_PLANE: true }))
import { DirectDatabasePanel } from '@/components/connect/DirectDatabasePanel'
import { forgetProjectReads } from '@/lib/api/projects'
import { clearProjectRoleCache } from '@/lib/hooks/useProjectRole'
import { EXPORT_COMPLETE_LINE } from '@/lib/services/export-completion'

const STATUS = { schema: 'workspace_p1', credentials: [], pendingDriftEvents: 0 }
const OWNER = { success: true, data: { id: 'p1', name: 'shop', region: null, role: 'OWNER', canWrite: true, canAdminister: true } }
const REFUSAL = "Nothing was exported: pg_dump could not connect to this project's database. Try again in a few minutes."
const STOPPED_SHORT = 'The backup stopped before it was complete. Nothing was saved. Try again.'
const named = (h: string) => (h.toLowerCase() === 'content-disposition' ? 'attachment; filename="shop-data-2026-11-16.sql"' : null)

let exportAnswer: () => unknown
const exportCalls: string[] = []
const createObjectURL = jest.fn((_blob: Blob) => 'blob:backup')
const revokeObjectURL = jest.fn()
let clicked: Array<{ href: string; download: string }> = []

beforeEach(() => {
  forgetProjectReads()
  clearProjectRoleCache()
  exportCalls.length = 0
  clicked = []
  createObjectURL.mockClear()
  ;(URL as any).createObjectURL = createObjectURL
  ;(URL as any).revokeObjectURL = revokeObjectURL
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.getAttribute('href') ?? '', download: this.download })
  })
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('/api/projects/p1/export/database')) {
      exportCalls.push(url)
      return Promise.resolve(exportAnswer())
    }
    const body = url.split('?')[0] === '/api/projects/p1' ? OWNER : STATUS
    return Promise.resolve({ ok: true, status: 200, json: async () => body })
  }) as unknown as typeof fetch
})

afterEach(() => {
  jest.restoreAllMocks()
})

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

async function renderPanel() {
  render(<DirectDatabasePanel projectId="p1" />)
  await settle()
}

it("shows the server's reason when the export fails, and saves nothing", async () => {
  exportAnswer = () => ({
    ok: false,
    status: 503,
    headers: { get: () => 'application/json' },
    json: async () => ({ error: REFUSAL, code: 'EXPORT_CONNECTION_FAILED' }),
  })
  await renderPanel()
  fireEvent.click(screen.getByRole('button', { name: 'Full backup (.sql)' }))
  await settle()

  expect(exportCalls).toEqual(['/api/projects/p1/export/database?mode=full'])
  expect(screen.getByText(REFUSAL)).toBeTruthy()
  expect(createObjectURL).not.toHaveBeenCalled()
  expect(clicked).toEqual([])
})

it('says the export did not finish when the answer carries no reason', async () => {
  exportAnswer = () => ({ ok: false, status: 502, headers: { get: () => null }, json: async () => { throw new Error('not json') } })
  await renderPanel()
  fireEvent.click(screen.getByRole('button', { name: 'Schema only' }))
  await settle()

  expect(exportCalls).toEqual(['/api/projects/p1/export/database?mode=schema'])
  expect(screen.getByText('The backup did not finish (HTTP 502). Nothing was downloaded. Try again.')).toBeTruthy()
  expect(createObjectURL).not.toHaveBeenCalled()
})

it('saves a finished export under the name the server gives it', async () => {
  exportAnswer = () => ({
    ok: true,
    status: 200,
    headers: { get: named },
    blob: async () => new Blob([`-- Backenly database export\nCOPY orders FROM stdin;\n\\.\n\n${EXPORT_COMPLETE_LINE}\n`]),
  })
  await renderPanel()
  fireEvent.click(screen.getByRole('button', { name: 'Data only' }))
  await waitFor(() => expect(screen.getByText('Downloaded shop-data-2026-11-16.sql.')).toBeTruthy())

  expect(exportCalls).toEqual(['/api/projects/p1/export/database?mode=data'])
  expect(createObjectURL).toHaveBeenCalledTimes(1)
  expect(clicked).toEqual([{ href: 'blob:backup', download: 'shop-data-2026-11-16.sql' }])
})

it('saves nothing when the download ends without the line that says the export is whole', async () => {
  exportAnswer = () => ({
    ok: true,
    status: 200,
    headers: { get: named },
    // Everything pg_dump wrote before it failed: a whole-looking file to anyone who does not check.
    blob: async () => new Blob(['-- Backenly database export\nCREATE TABLE orders (id uuid);\nCOPY orders FROM stdin;\n']),
  })
  await renderPanel()
  fireEvent.click(screen.getByRole('button', { name: 'Full backup (.sql)' }))
  await waitFor(() => expect(screen.getByText(STOPPED_SHORT)).toBeTruthy())

  expect(createObjectURL).not.toHaveBeenCalled()
  expect(clicked).toEqual([])
})

it('saves nothing when the connection is cut while the backup is arriving', async () => {
  exportAnswer = () => ({
    ok: true,
    status: 200,
    headers: { get: named },
    blob: async () => { throw new TypeError('network error') },
  })
  await renderPanel()
  fireEvent.click(screen.getByRole('button', { name: 'Full backup (.sql)' }))
  await waitFor(() => expect(screen.getByText(STOPPED_SHORT)).toBeTruthy())

  expect(createObjectURL).not.toHaveBeenCalled()
  expect(clicked).toEqual([])
})
