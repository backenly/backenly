/**
 * @jest-environment jsdom
 */
/**
 * THE RECORD DRAWER'S KEYS AND FOCUS (components/console/RecordDrawer.tsx)
 * =======================================================================
 * Project decision 6 opens one record from a list you keep scanning (a row,
 * a user, a file, a History change) in a non-modal drawer beside the list.
 * What that has to guarantee, and what this pins:
 *
 *   - opening moves focus to the record's title, and the list stays usable
 *     (no aria-modal on a desktop);
 *   - ↑ / ↓ move to the previous / next record, and do nothing at the ends;
 *   - arrows typed in a field of the drawer stay in the field;
 *   - Esc closes and gives focus back to the row that opened it; in a field,
 *     the first Esc only leaves the field, so a half-typed edit survives;
 *   - a dialog opened from the drawer keeps its own Esc;
 *   - a move to another record is announced.
 */
import { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { RecordDrawer, recordNav } from '@/components/console/RecordDrawer'

const ITEMS = ['alpha', 'beta', 'gamma']

function Harness({ withDialog = false }: { withDialog?: boolean }) {
  const [open, setOpen] = useState<number | null>(null)
  const [dialog, setDialog] = useState(false)
  const nav = recordNav(ITEMS, (x) => x, open === null ? null : ITEMS[open], (id) => setOpen(ITEMS.indexOf(id)))
  return (
    <>
      <ul>
        {ITEMS.map((x, i) => (
          <li key={x}>
            <button type="button" onClick={() => setOpen(i)}>
              Open {x}
            </button>
          </li>
        ))}
      </ul>
      <RecordDrawer
        open={nav.item !== null}
        onClose={() => setOpen(null)}
        title={nav.item ?? ''}
        onPrev={nav.onPrev}
        onNext={nav.onNext}
        position={nav.position}
        footer={<button type="button">Save</button>}
      >
        <label>
          Note
          <input aria-label="Note" />
        </label>
        <button type="button" onClick={() => setDialog(true)}>
          Delete
        </button>
        {withDialog && dialog && (
          <div role="dialog" aria-modal="true" aria-label="Confirm">
            <button type="button">Keep</button>
          </div>
        )}
      </RecordDrawer>
    </>
  )
}

/** Focus the row first, as a real click does, then open it. */
function openRow(name: string) {
  const row = screen.getByRole('button', { name: `Open ${name}` })
  row.focus()
  fireEvent.click(row)
  return row
}

const title = () => screen.getByRole('heading', { level: 2 })
const key = (target: Element, k: string) => fireEvent.keyDown(target, { key: k })

describe('RecordDrawer', () => {
  it('opens beside the list without trapping it, and moves focus to the title', () => {
    render(<Harness />)
    openRow('beta')
    const drawer = screen.getByRole('dialog')
    expect(drawer).toHaveAccessibleName('beta')
    expect(drawer).not.toHaveAttribute('aria-modal')
    expect(document.activeElement).toBe(title())
    expect(screen.getByText('2 of 3')).toBeInTheDocument()
  })

  it('moves with ↓ and ↑, and stops at the ends', () => {
    render(<Harness />)
    openRow('alpha')
    key(document.activeElement!, 'ArrowUp')
    expect(title()).toHaveTextContent('alpha')
    expect(screen.getByRole('button', { name: 'Previous record' })).toBeDisabled()

    key(document.activeElement!, 'ArrowDown')
    expect(title()).toHaveTextContent('beta')
    key(document.activeElement!, 'ArrowDown')
    expect(title()).toHaveTextContent('gamma')
    key(document.activeElement!, 'ArrowDown')
    expect(title()).toHaveTextContent('gamma')
    expect(screen.getByRole('button', { name: 'Next record' })).toBeDisabled()

    key(document.activeElement!, 'ArrowUp')
    expect(title()).toHaveTextContent('beta')
  })

  it('moves with the header buttons too', () => {
    render(<Harness />)
    openRow('alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Next record' }))
    expect(title()).toHaveTextContent('beta')
    fireEvent.click(screen.getByRole('button', { name: 'Previous record' }))
    expect(title()).toHaveTextContent('alpha')
  })

  it('leaves arrow keys to a field being typed in', () => {
    render(<Harness />)
    openRow('beta')
    const field = screen.getByLabelText('Note')
    field.focus()
    key(field, 'ArrowDown')
    key(field, 'ArrowUp')
    expect(title()).toHaveTextContent('beta')
  })

  it('ignores arrows with a modifier, which belong to the browser and the system', () => {
    render(<Harness />)
    openRow('beta')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown', metaKey: true })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown', altKey: true })
    expect(title()).toHaveTextContent('beta')
  })

  it('closes on Esc and gives focus back to the row that opened it', () => {
    render(<Harness />)
    const row = openRow('gamma')
    key(document.activeElement!, 'Escape')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(row)
  })

  it('closes with the close button too', () => {
    render(<Harness />)
    const row = openRow('alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(row)
  })

  it('takes the first Esc in a field as leaving the field, so an edit is not thrown away', () => {
    render(<Harness />)
    openRow('beta')
    const field = screen.getByLabelText('Note')
    field.focus()
    key(field, 'Escape')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(document.activeElement).toBe(title())
    key(document.activeElement!, 'Escape')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('leaves Esc to a dialog opened from the drawer', () => {
    render(<Harness withDialog />)
    openRow('beta')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const keep = screen.getByRole('button', { name: 'Keep' })
    keep.focus()
    key(keep, 'Escape')
    key(keep, 'ArrowDown')
    expect(screen.getByRole('dialog', { name: 'beta' })).toBeInTheDocument()
    expect(title()).toHaveTextContent('beta')
  })

  it('announces the record it moves to', () => {
    render(<Harness />)
    openRow('alpha')
    const live = document.querySelector('[aria-live="polite"]')!
    expect(live).toHaveTextContent('')
    act(() => {
      key(document.activeElement!, 'ArrowDown')
    })
    expect(live).toHaveTextContent('beta')
  })
})

describe('recordNav', () => {
  it('knows the open record, its place and its moves', () => {
    const open = jest.fn()
    const nav = recordNav(['a', 'b', 'c'], (x) => x, 'b', open)
    expect(nav.item).toBe('b')
    expect(nav.position).toEqual({ index: 1, total: 3 })
    nav.onPrev?.()
    nav.onNext?.()
    expect(open.mock.calls).toEqual([['a'], ['c']])
  })

  it('has no moves at the ends, and no record for an id the list does not have', () => {
    expect(recordNav(['a', 'b'], (x) => x, 'a', jest.fn()).onPrev).toBeNull()
    expect(recordNav(['a', 'b'], (x) => x, 'b', jest.fn()).onNext).toBeNull()
    const missing = recordNav(['a', 'b'], (x) => x, 'z', jest.fn())
    expect(missing.item).toBeNull()
    expect(missing.onNext).toBeNull()
  })
})
