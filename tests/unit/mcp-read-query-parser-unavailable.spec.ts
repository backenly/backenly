/**
 * ── No parser, no query ─────────────────────────────────────────────────────
 *
 * The parser in lib/mcp/read-query-ast.ts is the only thing that can tell a
 * read of this project's tables from a read of the shared catalogs. If its
 * WebAssembly is missing from an image or fails to load, the text checks are
 * still there, and they admit `SELECT 1` and plenty worse. So a missing parser
 * must refuse every statement, as Backenly's failure (503), never fall back to
 * the text checks alone, and try to load again on the next call.
 *
 * The package itself is replaced here, not the database: libpg-query is made to
 * fail to load the way a missing libpg-query.wasm does.
 */

const mockLoadModule = jest.fn(() =>
  Promise.reject(new Error("ENOENT: no such file or directory, open '/app/node_modules/libpg-query/wasm/libpg-query.wasm'")),
)

jest.mock('libpg-query', () => ({
  loadModule: () => mockLoadModule(),
  parse: () => Promise.reject(new Error('WASM module not initialized. Call `loadModule()` first.')),
}))

import { admitReadQuery, runReadQuery } from '@/lib/mcp/read-query'
import { PARSER_UNAVAILABLE } from '@/lib/mcp/read-query-ast'

const PROJECT = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b'

let consoleError: jest.SpyInstance

beforeEach(() => {
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleError.mockRestore()
})

describe('when the SQL parser cannot be loaded', () => {
  it('refuses a statement the text checks alone would admit', async () => {
    await expect(admitReadQuery('SELECT * FROM posts', PROJECT)).rejects.toMatchObject({
      code: 'SQL_PARSER_UNAVAILABLE',
      status: 503,
      message: PARSER_UNAVAILABLE,
    })
  })

  it('says nothing to the caller about the file it could not read, and logs it for operators', async () => {
    let caught: Error | null = null
    try {
      await admitReadQuery('SELECT 1', PROJECT)
    } catch (err) {
      caught = err as Error
    }
    expect(caught?.message).not.toMatch(/ENOENT|wasm|node_modules/)
    expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/SQL parser could not be loaded.*ENOENT/))
  })

  it('refuses before run_query opens a connection', async () => {
    await expect(runReadQuery(PROJECT, 'SELECT 1')).rejects.toMatchObject({ code: 'SQL_PARSER_UNAVAILABLE', status: 503 })
  })

  it('tries to load the parser again on the next call instead of remembering the failure', async () => {
    const before = mockLoadModule.mock.calls.length
    await expect(admitReadQuery('SELECT 1', PROJECT)).rejects.toMatchObject({ code: 'SQL_PARSER_UNAVAILABLE' })
    await expect(admitReadQuery('SELECT 2', PROJECT)).rejects.toMatchObject({ code: 'SQL_PARSER_UNAVAILABLE' })
    expect(mockLoadModule.mock.calls.length - before).toBe(2)
  })
})
