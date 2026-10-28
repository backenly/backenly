/**
 * Branch-merge copy matches the live engine (medium finding BR-08).
 *
 * The console header, the empty state, the panel's route comment and
 * /docs/branches all described the retired additive merge ("new tables merge
 * back; anything else comes back for review"), while the engine at this SHA
 * replays every logged statement onto production. A user reading the old
 * words would expect non-additive changes to be filtered into review items;
 * in reality everything in the branch's log reaches production when the
 * merge is approved.
 */

import fs from 'fs'
import path from 'path'

const ROOT = process.cwd()
const page = fs.readFileSync(path.join(ROOT, 'app', 'app', 'projects', '[id]', 'branches', 'page.tsx'), 'utf8')
const panel = fs.readFileSync(path.join(ROOT, 'components', 'branches', 'BranchesPanel.tsx'), 'utf8')
const docs = fs.readFileSync(path.join(ROOT, 'app', 'docs', 'content.ts'), 'utf8')

describe('BR-08: the retired additive-merge story is gone', () => {
  it.each([
    ['branches page', () => page],
    ['branches panel', () => panel],
    ['console docs', () => docs],
  ])('%s no longer claims new-tables-only merging', (_name, read) => {
    const src = read()
    expect(src).not.toContain('merge back through the governed path')
    expect(src).not.toContain('additive auto, rest')
  })

  it('all three surfaces describe the replay the engine performs', () => {
    // The page header, and with it this sentence, moved into the panel so its
    // New branch action can open the panel's dialog.
    expect(panel).toContain('replays the branch')
    expect(docs).toContain('replays the branch')
  })
})
