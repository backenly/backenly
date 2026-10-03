/**
 * EXTRACTION IS THE ONE STEP WHERE THE ARCHIVE CHOOSES WHERE BYTES LAND
 * ====================================================================
 * Everywhere else in a restore, this code decides what happens. Here the tar
 * entry names the destination, and an extractor that trusts the name writes
 * wherever it is told - including outside the storage directory.
 *
 * So the round trip is tested against the real writer (`archiver`, which is
 * what produces these archives), and the refusal is tested against names an
 * archive would only contain on purpose.
 */

import archiver from 'archiver'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { extractTar, readTar, safeDestination, TarFormatError } from '@/lib/recovery/tar'

jest.setTimeout(60_000)

const dirs: string[] = []
afterAll(async () => {
  for (const dir of dirs) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** Build an archive the same way the exporter does. */
function tarDirectory(dir: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const archive = archiver('tar', {})
    archive.on('data', (c: Buffer) => chunks.push(c))
    archive.on('error', reject)
    archive.on('end', () => resolve(Buffer.concat(chunks)))
    archive.directory(dir, false)
    archive.finalize().catch(reject)
  })
}

describe('round trip through the real writer', () => {
  it('restores files, contents and nesting', async () => {
    // Against archiver rather than a hand-built fixture, because archiver is
    // the only thing that produces these archives. A reader tested against its
    // own idea of tar proves nothing about the files it will actually meet.
    const source = await tempDir('tar-src-')
    await fs.promises.mkdir(path.join(source, 'bucket', 'nested'), { recursive: true })
    await fs.promises.writeFile(path.join(source, 'top.txt'), 'top level')
    await fs.promises.writeFile(path.join(source, 'bucket', 'a.bin'), Buffer.from([0, 1, 2, 255]))
    await fs.promises.writeFile(path.join(source, 'bucket', 'nested', 'deep.txt'), 'deep')

    const archive = await tarDirectory(source)
    const dest = await tempDir('tar-dst-')
    const written = await extractTar(archive, dest)

    expect(written).toBe(3)
    expect(await fs.promises.readFile(path.join(dest, 'top.txt'), 'utf8')).toBe('top level')
    expect(await fs.promises.readFile(path.join(dest, 'bucket', 'nested', 'deep.txt'), 'utf8')).toBe('deep')
    const binary = await fs.promises.readFile(path.join(dest, 'bucket', 'a.bin'))
    expect([...binary]).toEqual([0, 1, 2, 255])
  })

  it('handles an empty file without losing it', async () => {
    // A zero-byte object is a real thing to store, and a reader that skips
    // entries with no data would drop it silently.
    const source = await tempDir('tar-empty-')
    await fs.promises.writeFile(path.join(source, 'empty.txt'), '')
    const dest = await tempDir('tar-empty-dst-')

    expect(await extractTar(await tarDirectory(source), dest)).toBe(1)
    expect(await fs.promises.readFile(path.join(dest, 'empty.txt'), 'utf8')).toBe('')
  })

  it('handles a file large enough to span many blocks', async () => {
    // tar is block-structured, so sizes that are not a multiple of 512 are
    // where an off-by-one in the padding arithmetic shows up.
    const source = await tempDir('tar-big-')
    const content = Buffer.alloc(5000, 0xab)
    await fs.promises.writeFile(path.join(source, 'big.bin'), content)
    const dest = await tempDir('tar-big-dst-')

    await extractTar(await tarDirectory(source), dest)
    const restored = await fs.promises.readFile(path.join(dest, 'big.bin'))
    expect(restored.length).toBe(5000)
    expect(restored.equals(content)).toBe(true)
  })

  it('handles a long path, which changes how tar stores the name', async () => {
    // Past 100 characters the name moves into the ustar prefix field or a GNU
    // long-name record, and a reader that only looks at the first field starts
    // producing truncated paths.
    const source = await tempDir('tar-long-')
    const deep = path.join(source, 'a'.repeat(60), 'b'.repeat(60))
    await fs.promises.mkdir(deep, { recursive: true })
    await fs.promises.writeFile(path.join(deep, 'c.txt'), 'long path')
    const dest = await tempDir('tar-long-dst-')

    await extractTar(await tarDirectory(source), dest)
    const restored = await fs.promises.readFile(
      path.join(dest, 'a'.repeat(60), 'b'.repeat(60), 'c.txt'),
      'utf8',
    )
    expect(restored).toBe('long path')
  })

  it('stops at the end of the archive rather than reading past it', async () => {
    const source = await tempDir('tar-end-')
    await fs.promises.writeFile(path.join(source, 'one.txt'), 'x')
    expect(readTar(await tarDirectory(source)).filter(e => e.type === 'file')).toHaveLength(1)
  })
})

/**
 * A single ustar entry, built by hand.
 *
 * Needed because archiver sanitises the names that make an archive dangerous,
 * so the only way to test the refusal is to forge what a hostile archive would
 * actually contain.
 */
function tarHeaderAndData(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100, 8, 'ascii') // mode
  header.write('0000000\0', 108, 8, 'ascii') // uid
  header.write('0000000\0', 116, 8, 'ascii') // gid
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii')
  header.write('00000000000\0', 136, 12, 'ascii') // mtime
  header.write('        ', 148, 8, 'ascii') // checksum placeholder
  header.write('0', 156, 1, 'ascii') // typeflag: regular file
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')

  // The checksum is computed with the checksum field read as spaces, which is
  // why the placeholder above is written first.
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')

  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512)
  data.copy(padded)
  return Buffer.concat([header, padded])
}

describe('an entry may not name somewhere else', () => {
  it('accepts ordinary names', () => {
    const dest = path.resolve('/tmp/storage')
    expect(safeDestination(dest, 'bucket/file.txt')).not.toBeNull()
    expect(safeDestination(dest, 'file.txt')).not.toBeNull()
  })

  it('refuses parent traversal', () => {
    const dest = path.resolve('/tmp/storage')
    expect(safeDestination(dest, '../escape.txt')).toBeNull()
    expect(safeDestination(dest, 'bucket/../../escape.txt')).toBeNull()
    expect(safeDestination(dest, 'a/b/../../../escape.txt')).toBeNull()
  })

  it('refuses absolute paths', () => {
    const dest = path.resolve('/tmp/storage')
    expect(safeDestination(dest, '/etc/passwd')).toBeNull()
    expect(safeDestination(dest, '//etc/passwd')).toBeNull()
  })

  it('refuses Windows shapes, which are a different way to say elsewhere', () => {
    const dest = path.resolve('/tmp/storage')
    expect(safeDestination(dest, 'C:/Windows/system32/x.dll')).toBeNull()
    expect(safeDestination(dest, '..\\escape.txt')).toBeNull()
  })

  it('refuses an empty name', () => {
    expect(safeDestination(path.resolve('/tmp/storage'), '')).toBeNull()
  })

  it('does not confuse a sibling directory with a prefix match', () => {
    // `/tmp/storage-other` starts with `/tmp/storage`, and a naive
    // startsWith check would accept it.
    const dest = path.resolve('/tmp/storage')
    const escape = safeDestination(dest, '../storage-other/file.txt')
    expect(escape).toBeNull()
  })

  it('refuses the whole archive when one entry tries to escape', async () => {
    // Built byte by byte rather than through archiver, which sanitises names -
    // so an archive it produced could never carry the attack, and a test using
    // it would assert nothing. A hostile archive does not come from our
    // exporter, so it has to be forged to be tested.
    //
    // Refused wholesale, not skipped: a bundle containing a traversal attempt
    // is not a bundle to partially trust.
    const dest = await tempDir('tar-evil-dst-')
    const archive = Buffer.concat([
      tarHeaderAndData('fine.txt', Buffer.from('harmless')),
      tarHeaderAndData('../escaped.txt', Buffer.from('malicious')),
      Buffer.alloc(1024),
    ])

    await expect(extractTar(archive, dest)).rejects.toThrow(TarFormatError)
    await expect(
      fs.promises.readFile(path.join(path.dirname(dest), 'escaped.txt'), 'utf8'),
    ).rejects.toThrow()
  })

  it('refuses a forged absolute name too', async () => {
    const dest = await tempDir('tar-abs-dst-')
    const archive = Buffer.concat([
      tarHeaderAndData('/etc/backenly-probe.txt', Buffer.from('nope')),
      Buffer.alloc(1024),
    ])
    await expect(extractTar(archive, dest)).rejects.toThrow(TarFormatError)
  })
})
