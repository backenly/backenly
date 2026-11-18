/**
 * @jest-environment jsdom
 */
/**
 * The Storage page shows who may upload into the bucket in view, and a person
 * who may change the project's settings changes it there: "Signed-in users of
 * your app" or "Only your server". A bucket says who may upload into it
 * (lib/storage/upload-access.ts); the agent changes it with storage set_uploads,
 * and the console with this.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { StorageWorkbench } from '@/components/storage/StorageWorkbench'

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  // The open bucket and file live in the URL (?bucket=, ?file=).
  useSearchParams: () => new URLSearchParams(window.location.search),
}))

const PROJECT = '00000000-0000-4000-8000-000000000002'
// The console keeps one role answer per project for the life of the page, so the viewer has a project of their own.
const VIEWERS_PROJECT = '00000000-0000-4000-8000-000000000003'
const BUCKET = { id: 'b1', name: 'photos', isPublic: true, accessPolicy: 'public_read', uploads: 'server_only', fileCount: 0, totalSize: 0 }

let role: { role: string; canWrite: boolean; canAdminister: boolean }
let patches: Array<{ url: string; body: unknown }>

beforeEach(() => {
  role = { role: 'OWNER', canWrite: true, canAdminister: true }
  patches = []
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split('?')[0]
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body))
      patches.push({ url: path, body })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ bucket: { ...BUCKET, ...body } }) } as Response)
    }
    const body =
      path === '/api/storage/files' ? { success: true, total: 0, files: [] }
      : path === '/api/storage/buckets' ? { buckets: [BUCKET] }
      : path === '/api/storage/stats' ? { stats: { totalFiles: 0, totalSize: 0, buckets: [{ name: 'photos', fileCount: 0, totalSize: 0 }] } }
      : path.startsWith('/api/projects/') ? { success: true, data: { id: path.split('/')[3], name: 'shop', ...role } }
      : {}
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
  }) as unknown as typeof fetch
})

async function settle() {
  await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })
}

async function renderWorkbench(projectId = PROJECT) {
  window.history.replaceState(null, '', `/app/projects/${projectId}/storage?bucket=photos`)
  render(<StorageWorkbench projectId={projectId} />)
  await settle()
}

it('says who may upload into the bucket in view, and changes it to signed-in users', async () => {
  await renderWorkbench()
  fireEvent.click(screen.getByRole('button', { name: 'Upload access: Your server' }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText('Who can upload to')).toBeInTheDocument()
  const server = within(dialog).getByRole('radio', { name: /Only your server/ })
  const signedIn = within(dialog).getByRole('radio', { name: /Signed-in users of your app/ })
  expect(server).toBeChecked()
  expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()

  fireEvent.click(signedIn)
  expect(within(dialog).getByText('Anyone who signs up for your app can then add files to this bucket.')).toBeInTheDocument()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
  await settle()
  expect(patches).toEqual([{ url: '/api/storage/buckets/b1', body: { uploads: 'signed_in' } }])
})

it('offers it in the bucket’s menu beside read access', async () => {
  await renderWorkbench()
  fireEvent.click(screen.getByRole('button', { name: 'Actions for bucket photos' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Upload access…' }))
  expect(within(screen.getByRole('dialog')).getByRole('radio', { name: /Only your server/ })).toBeChecked()
})

it('shows a viewer who may upload, and offers no way to change it', async () => {
  role = { role: 'VIEWER', canWrite: false, canAdminister: false }
  await renderWorkbench(VIEWERS_PROJECT)
  expect(screen.getByText('Upload access: Your server')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Upload access: Your server' })).toBeNull()
})
