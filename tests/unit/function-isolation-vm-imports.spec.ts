/**
 * NOTHING BUT THE FUNCTION RUNNER LOADS node:vm
 * ==============================================
 *
 * node:vm is not a security mechanism; Node's own documentation says not to
 * run untrusted code in it. Function code ran in vm contexts inside the web
 * and runtime processes, and one line of it (`Object.constructor('return
 * process')()`) reached the real process: every platform secret in its
 * environment, the platform's database client, the operating system. Function
 * code now runs only in lib/services/ai-functions/isolation/function-runner.cjs,
 * which runs in a process of its own under a uid of its own, where escaping
 * the vm reaches nothing that is not the run's own.
 *
 * A vm context anywhere else is that hole coming back, however well it is
 * meant, so the build fails on the load itself: the vm module (bare or with
 * the node: prefix) or the isolated-vm package, by require, import, dynamic
 * import or process.getBuiltinModule, in any tracked or new source file.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const RUNNER = 'lib/services/ai-functions/isolation/function-runner.cjs'
const SOURCE = /\.(?:[cm]?[jt]sx?)$/
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'coverage', 'dist-runtime', 'dist-fn', 'workspace', 'backups'])

/** The module names, assembled so this file's own text never loads one. */
const VM = ['v', 'm'].join('')
const ISOLATED = `isolated-${VM}`
const NAMES = `(?:node:)?${VM}|${ISOLATED}`
const Q = '[\'"`]'

/** Every way a module can be loaded by name. */
const LOADS: RegExp[] = [
  new RegExp(`\\brequire\\s*\\(\\s*${Q}(?:${NAMES})${Q}\\s*\\)`),
  new RegExp(`\\bimport\\s*\\(\\s*${Q}(?:${NAMES})${Q}\\s*\\)`),
  new RegExp(`\\bfrom\\s*${Q}(?:${NAMES})${Q}`),
  new RegExp(`\\bimport\\s+${Q}(?:${NAMES})${Q}`),
  new RegExp(`\\bgetBuiltinModule\\s*\\(\\s*${Q}(?:${NAMES})${Q}\\s*\\)`),
]

const loads = (text: string) => LOADS.some((re) => re.test(text))

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) walk(path, out)
    else if (SOURCE.test(name)) out.push(relative(ROOT, path).replace(/\\/g, '/'))
  }
  return out
}

/** Tracked and new (not ignored) source files; a walk of the tree where git is absent. */
function sourceFiles(): string[] {
  try {
    const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    })
    return listed.split('\0').filter((f) => SOURCE.test(f))
  } catch {
    return walk(ROOT, [])
  }
}

describe('node:vm', () => {
  it('is loaded by the function runner and by no other source file', () => {
    const offenders = sourceFiles()
      .filter((file) => file !== RUNNER)
      .filter((file) => {
        const path = join(ROOT, file)
        return existsSync(path) && loads(readFileSync(path, 'utf8'))
      })
    expect(offenders).toEqual([])
  })

  it('is seen where it is loaded, so the scan above is looking at real files', () => {
    expect(sourceFiles()).toContain(RUNNER)
    expect(loads(readFileSync(join(ROOT, RUNNER), 'utf8'))).toBe(true)
  })

  it.each([
    [`const ${VM} = require('${VM}')`],
    [`const x = require("node:${VM}")`],
    [`import ${VM} from '${VM}'`],
    [`import * as ${VM} from "node:${VM}"`],
    [`import { Script } from '${VM}'`],
    [`export { runInNewContext } from 'node:${VM}'`],
    [`const m = await import('node:${VM}')`],
    [`const ivm = require('${ISOLATED}')`],
    [`import ivm from "${ISOLATED}"`],
    [`process.getBuiltinModule('${VM}')`],
    [`import '${VM}'`],
    [`require( \`${VM}\` )`],
  ])('is caught when loaded as: %s', (line) => {
    expect(loads(line)).toBe(true)
  })

  it.each([
    [`// the ${VM} module is not a security mechanism`],
    [`const ${VM}Name = 'a ${VM} context'`],
    [`require('./${VM}-free')`],
    [`import { x } from '@/lib/${VM}'`],
  ])('is not claimed for a line that loads nothing of it: %s', (line) => {
    expect(loads(line)).toBe(false)
  })
})
