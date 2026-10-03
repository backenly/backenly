/**
 * THE README IS THE SELF-HOST ACCEPTANCE SCRIPT
 * =============================================
 * A fresh self-hoster follows README.md, so a README that has drifted from what
 * `npm run bootstrap` prints does not merely go stale: it walks an operator down
 * a path that never reaches a working data plane, and the symptom arrives later
 * as PGRST106 on every table.
 *
 * That drift is not hypothetical. The quickstart stopped at `npm run dev` for
 * the whole life of the repository, omitting bootstrap, PostgREST and the
 * prerequisite chain entirely, while the chain itself grew two dependency
 * cycles that were found only by executing it rather than reading it.
 *
 * So the commands live in scripts/bootstrap-prerequisites.ts, bootstrap renders
 * its guidance from them, and this asserts README.md carries the same commands
 * in the same order. Adding a step without documenting it fails the build.
 *
 * No database: this compares committed text against committed code.
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  BOOTSTRAP_EXIT,
  PROJECT_ID_PLACEHOLDER,
  postgrestPrerequisiteSteps,
  prerequisiteCommands,
  renderPrerequisiteSteps,
} from '../../scripts/bootstrap-prerequisites'

const README = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8')

describe('README matches the bootstrap-generated guidance', () => {
  it('carries every prerequisite command, in the order bootstrap prints them', () => {
    const commands = prerequisiteCommands(PROJECT_ID_PLACEHOLDER)

    // Guards against the whole check passing vacuously if the chain were ever
    // reduced to an empty list. It has four commands today; fewer than that is
    // a change worth failing on and re-reading.
    expect(commands.length).toBeGreaterThanOrEqual(4)

    // Ordering matters and is the reason for the cursor: step 2 grants per
    // workspace schema, so it cannot precede the step that creates one.
    const missing: string[] = []
    const outOfOrder: string[] = []
    let cursor = 0
    for (const command of commands) {
      if (!README.includes(command)) {
        missing.push(command)
        continue
      }
      const at = README.indexOf(command, cursor)
      if (at < 0) outOfOrder.push(command)
      else cursor = at + command.length
    }

    expect({ missing, outOfOrder }).toEqual({ missing: [], outOfOrder: [] })
  })

  it('documents every exit code bootstrap can produce', () => {
    // Bootstrap exits with these exact values, so a new state cannot be added
    // without landing here and therefore in the README.
    const codes = Object.values(BOOTSTRAP_EXIT)
    expect(codes).toEqual([0, 2, 3])

    // Documented as a table row, not merely mentioned somewhere in prose.
    const undocumented = codes.filter(c => !README.includes(`| \`${c}\` |`))
    expect(undocumented).toEqual([])

    // Exit 3 is the one an operator MUST understand: it is the expected result
    // of the first run, and reading it as failure is the mistake the README
    // exists to prevent.
    expect(README).toContain('expected to exit 3')
  })

  it('warns that the PostgREST roles are cluster-global', () => {
    // backenly_pgrst_register_schema stores the served-schema list in
    // `ALTER ROLE ... SET pgrst.db_schemas` with no IN DATABASE clause, so two
    // Backenly databases on one cluster overwrite each other's registry. Until
    // that is redesigned, a self-hoster who is not told will hit it.
    expect(README).toContain('dedicated to this deployment')
    expect(README).toContain('IN DATABASE')
  })

  it('renders the same commands into the guidance the script prints', () => {
    // Closes the loop the other way: the README is checked against this module,
    // so the module must be what bootstrap actually emits rather than a second
    // description sitting alongside it.
    const steps = postgrestPrerequisiteSteps(PROJECT_ID_PLACEHOLDER)
    const rendered = renderPrerequisiteSteps(steps)
    for (const step of steps) {
      expect(rendered).toContain(step.note)
      if (step.command) expect(rendered).toContain(step.command)
    }
    expect(rendered).toContain('then rerun: npm run bootstrap')
  })
})
