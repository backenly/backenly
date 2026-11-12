/**
 * @jest-environment jsdom
 */
/**
 * The Storage page shows who sent each file, in the table and the detail pane.
 * Production QA (2026-11-09): nothing on the page could show that a caller with
 * only the public key had uploaded anon.png into a store's bucket.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { StorageWorkbench } from '@/components/storage/StorageWorkbench'

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }))

const PROJECT = '00000000-0000-4000-8000-000000000001'
const file = (id: string, name: string, uploader: unknown) => ({
  id, name, size: 12, mimeType: 'image/png', isPublic: true, bucket: 'photos',
  createdAt: new Date().toISOString(), url: `/api/storage/files/${id}/download`, uploader,
})
const FILES = [
  file('f1', 'anon.png', { kind: 'anonymous', label: 'Anonymous' }),
  file('f2', 'mug.png', { kind: 'end_user', label: 'shopper@example.test' }),
  file('f3', 'old.png', null),
]

beforeEach(() => {
  window.history.replaceState(null, '', `/app/projects/${PROJECT}/storage`)
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]
    const body =
      path === '/api/storage/files' ? { success: true, total: FILES.length, files: FILES }
      : path === '/api/storage/buckets' ? { buckets: [{ id: 'b1', name: 'photos', isPublic: true, accessPolicy: 'public_read', fileCount: 3, totalSize: 36 }] }
      : path === '/api/storage/stats' ? { stats: { totalFiles: 3, totalSize: 36, buckets: [{ name: 'photos', fileCount: 3, totalSize: 36 }] } }
      : path === `/api/projects/${PROJECT}` ? { success: true, data: { id: PROJECT, name: 'shopqa' } }
      : {}
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
  }) as unknown as typeof fetch
})

async function renderWorkbench() {
  render(<StorageWorkbench projectId={PROJECT} />)
  await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })
}

it('has an Uploaded by column naming each file’s uploader', async () => {
  await renderWorkbench()
  expect(screen.getByRole('columnheader', { name: 'Uploaded by' })).toBeInTheDocument()
  const row = (name: string) => screen.getByText(name).closest('tr') as HTMLElement
  expect(within(row('anon.png')).getByText('Anonymous')).toHaveAttribute('title', 'Anonymous: Sent with the public key, by no signed-in user')
  expect(within(row('mug.png')).getByText('shopper@example.test')).toBeInTheDocument()
  expect(within(row('old.png')).getByText('—')).toHaveAttribute('title', '—: Not recorded for this file')
})

it('names the uploader in the detail pane', async () => {
  await renderWorkbench()
  fireEvent.click(screen.getByText('anon.png'))
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })
  const term = screen.getByText('Uploaded by', { selector: 'dt' })
  expect(term.nextElementSibling).toHaveTextContent('Anonymous')
})
