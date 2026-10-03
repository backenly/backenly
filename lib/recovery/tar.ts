/**
 * READING THE STORAGE ARCHIVE BACK OUT
 * ====================================
 *
 * The bundle writes storage objects with `archiver`, which produces plain
 * ustar. Reading it back needs a few hundred bytes of header parsing, and doing
 * it here rather than reaching for a library is a deliberate trade.
 *
 * `tar-stream` is present in node_modules, but only as something archiver
 * depends on, and it ships no types. Depending on another package's transitive
 * dependency is the kind of thing that works until an unrelated upgrade removes
 * it, and it would fail inside the recovery path - the one place where "it used
 * to work" is least acceptable.
 *
 * The more important reason is that extraction is the only step in a restore
 * where the ARCHIVE chooses where bytes land. A tar entry can name
 * `../../etc/anything`, and an extractor that trusts the name writes wherever
 * it is told. Refusing that has to be unconditional and it has to be visible,
 * so it is written here rather than configured somewhere on a library call.
 */

import * as fs from 'fs'
import * as path from 'path'

const BLOCK = 512

export class TarFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TarFormatError'
  }
}

function readString(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8')
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const text = readString(block, offset, length).trim()
  if (text === '') return 0
  const value = parseInt(text, 8)
  if (!Number.isFinite(value) || value < 0) {
    throw new TarFormatError(`Malformed size field in the storage archive: ${JSON.stringify(text)}`)
  }
  return value
}

export interface TarEntry {
  name: string
  type: 'file' | 'directory'
  content: Buffer
}

/** Parse a ustar archive into entries. */
export function readTar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = []
  let offset = 0
  /** Set by a GNU long-name record, consumed by the entry that follows it. */
  let pendingLongName: string | null = null

  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK)

    // Two consecutive zero blocks end the archive; one is enough to stop on.
    if (header.every(byte => byte === 0)) break

    const size = readOctal(header, 124, 12)
    const typeflag = String.fromCharCode(header[156]) || '0'
    const prefix = readString(header, 345, 155)
    const base = readString(header, 0, 100)
    const name = pendingLongName ?? (prefix ? `${prefix}/${base}` : base)
    pendingLongName = null

    const dataStart = offset + BLOCK
    const data = archive.subarray(dataStart, dataStart + size)
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK

    if (typeflag === 'L') {
      // GNU long name: this record's DATA is the next entry's name.
      pendingLongName = data.toString('utf8').replace(/\0+$/, '')
      continue
    }
    // Pax and global headers carry metadata, not content worth restoring.
    if (typeflag === 'x' || typeflag === 'g') continue

    if (typeflag === '5') {
      entries.push({ name, type: 'directory', content: Buffer.alloc(0) })
    } else if (typeflag === '0' || typeflag === '\0' || header[156] === 0) {
      entries.push({ name, type: 'file', content: Buffer.from(data) })
    }
    // Links, devices and FIFOs are skipped. Storage objects are plain files,
    // and restoring a symlink from an archive is a way to write outside the
    // destination that path checking alone would not catch.
  }

  return entries
}

/**
 * Where an entry is allowed to land.
 *
 * Exported because it is the security-relevant half and deserves its own tests.
 * Returns null for anything that would escape the destination.
 */
export function safeDestination(destDir: string, entryName: string): string | null {
  // Windows separators are just another way to write a path, so they are
  // normalised before the checks rather than being a second set of rules.
  const normalised = entryName.replace(/\\/g, '/')

  // An absolute name is REFUSED, not stripped. GNU tar's habit of quietly
  // turning /etc/passwd into ./etc/passwd is safe but surprising, and it is the
  // wrong default here: this exporter only ever writes relative names, so an
  // absolute one means the archive did not come from it. Relocating it would
  // hide that; refusing says so.
  if (normalised === '' || normalised.startsWith('/')) return null
  if (/^[A-Za-z]:/.test(normalised)) return null
  if (normalised.split('/').includes('..')) return null

  const resolvedDest = path.resolve(destDir)
  const target = path.resolve(resolvedDest, normalised)

  // The final check, after resolution, so a name that survived the checks above
  // through some encoding still cannot land outside.
  const withSep = resolvedDest.endsWith(path.sep) ? resolvedDest : resolvedDest + path.sep
  if (target !== resolvedDest && !target.startsWith(withSep)) return null

  return target
}

/** Extract an archive into a directory. Returns how many files were written. */
export async function extractTar(archive: Buffer, destDir: string): Promise<number> {
  await fs.promises.mkdir(/*turbopackIgnore: true*/ destDir, { recursive: true })

  let written = 0
  for (const entry of readTar(archive)) {
    const target = safeDestination(destDir, entry.name)
    if (target === null) {
      throw new TarFormatError(
        `The storage archive contains an entry named ${JSON.stringify(entry.name)}, which ` +
        `would be written outside ${destDir}. Refusing to extract it.`,
      )
    }

    if (entry.type === 'directory') {
      await fs.promises.mkdir(/*turbopackIgnore: true*/ target, { recursive: true })
      continue
    }

    await fs.promises.mkdir(/*turbopackIgnore: true*/ path.dirname(target), { recursive: true })
    await fs.promises.writeFile(/*turbopackIgnore: true*/ target, entry.content)
    written += 1
  }

  return written
}
