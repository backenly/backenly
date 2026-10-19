/**
 * A change's one-line summary names what was asked for.
 *
 * A project's first table brings Backenly's own helper functions with it (the
 * updatedAt stamp and the end-user claim reader). They are in the change's
 * footprint, and View details lists them, but the summary is about the table:
 * "Created table notebooks", not "Created notebooks and changed 2 views,
 * functions or types".
 */

import { describeChange } from '@/lib/changes/describe'
import type { TableChange } from '@/lib/changes/types'

const table = (after: string): TableChange => ({ kind: 'added', before: null, after, details: [] })
const fn = (after: string): TableChange => ({ kind: 'added', object: 'function', before: null, after, details: [] })

describe('describeChange', () => {
  it('names the table a first table came with, not the helpers it brought', () => {
    expect(describeChange([table('notebooks'), fn('set_updated_at()'), fn('backenly_jwt_claim(claim text)')])).toBe('Created table notebooks')
  })

  it('still names a function that is not one of Backenly\'s own', () => {
    expect(describeChange([table('notebooks'), fn('order_total(uuid)')])).toBe('Created notebooks and created function order_total(uuid)')
  })

  it('describes a change made only of helpers as what it is', () => {
    expect(describeChange([fn('set_updated_at()')])).toBe('Created function set_updated_at()')
  })

  it('says when nothing changed', () => {
    expect(describeChange([])).toBe('Changed nothing')
  })
})
