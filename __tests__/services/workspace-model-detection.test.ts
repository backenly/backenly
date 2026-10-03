/**
 * Model discovery reads real workspace directories, and nothing covered it.
 *
 * `detectMongooseModels` walks `workspace/<projectId>/…` looking for Mongoose
 * schemas. Those paths are built from runtime user data, so Next's tracer
 * cannot resolve them and falls back to tracing the whole repository into
 * `.next/standalone`. The fix is a file-tracing opt-out on the filesystem calls
 * here — which changes nothing at runtime, and therefore needs a test that
 * would notice if it ever did.
 *
 * This builds a real temporary workspace rather than mocking `fs`, because a
 * mocked filesystem would keep passing even if the annotation broke the reads.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { detectMongooseModels } from '@/lib/services/workspaceDatabaseSetup'

let base: string

function write(rel: string, contents: string): void {
  const full = path.join(base, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents)
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-models-'))
})
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe('detectMongooseModels', () => {
  it('finds models declared with mongoose.model(...)', async () => {
    write(
      'src/models/User.ts',
      `import mongoose from 'mongoose'
       const schema = new mongoose.Schema({ email: String })
       export default mongoose.model('User', schema)`,
    )
    write(
      'src/models/Order.ts',
      `import mongoose from 'mongoose'
       const schema = new mongoose.Schema({ total: Number })
       export default mongoose.model('Order', schema)`,
    )

    const found = await detectMongooseModels(base)
    expect(found.map((m) => m.name).sort()).toEqual(['Order', 'User'])
  })

  it('searches every documented workspace layout', async () => {
    // The function probes several conventional locations; a regression that
    // silently narrowed that list would still pass a single-layout test.
    write('models/Alpha.ts', `model('Alpha', s)`)
    write('lib/models/Beta.ts', `model('Beta', s)`)
    write('mongo/models/Gamma.ts', `model('Gamma', s)`)
    write('src/mongo/models/Delta.ts', `model('Delta', s)`)

    const names = (await detectMongooseModels(base)).map((m) => m.name).sort()
    expect(names).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma'])
  })

  it('ignores non-source files and directories that do not exist', async () => {
    write('src/models/User.ts', `model('User', s)`)
    write('src/models/README.md', `model('NotAModel', s)`)
    write('src/models/notes.txt', `model('AlsoNot', s)`)

    const names = (await detectMongooseModels(base)).map((m) => m.name)
    expect(names).toEqual(['User'])
  })

  it('returns nothing for a workspace with no model directories', async () => {
    write('src/index.ts', `console.log('no models here')`)
    await expect(detectMongooseModels(base)).resolves.toEqual([])
  })

  it('does not throw when the workspace directory is absent entirely', async () => {
    await expect(detectMongooseModels(path.join(base, 'no-such-project'))).resolves.toEqual([])
  })

  it('reports a path for each model it found', async () => {
    write('src/models/User.ts', `model('User', s)`)
    const [found] = await detectMongooseModels(base)
    expect(found.filePath).toContain('User.ts')
  })
})
