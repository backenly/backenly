/**
 * A CACHE THAT NEVER ANSWERS WITH AN OLDER EPOCH THAN IT WAS TOLD ABOUT
 * =====================================================================
 * Where a project's data lives is read from its platform row and cached for
 * the life of the process (lib/data-plane/regional.ts projectDatabase): the
 * region never changes, and the database changes only when the project's data
 * is moved to another one, which moves the row's `tenancyEpoch`.
 *
 * A process learns that an epoch moved from a read that carries it (the
 * project's row, read for another reason, or a serving-state read). It says so
 * with `note`, and from then on this cache never answers with a value of an
 * older epoch:
 *
 *   - a cached value older than the noted epoch is dropped and read again;
 *   - a read that was already in flight when the epoch was noted, and comes
 *     back with the older value, is neither cached nor returned: the value is
 *     read again;
 *   - a read that keeps coming back older than the noted epoch fails with
 *     EpochBehindError rather than answering with it.
 *
 * Bounded: values and noted epochs are each capped, oldest entry out first.
 * Pure, with the read injected, so the rules are tested without a database
 * (tests/unit/project-database-resolution.spec.ts).
 */

/** A read keeps returning an epoch older than one this process was told about. */
export class EpochBehindError extends Error {
  constructor(
    readonly key: string,
    readonly read: number,
    readonly expected: number,
  ) {
    super(`The record for ${key} reads epoch ${read}, older than epoch ${expected} this process was told about.`)
    this.name = 'EpochBehindError'
  }
}

/** How many times a read that came back older than the noted epoch is tried again. */
const READ_ATTEMPTS = 3

function setBounded<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key)
  if (map.size >= max) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, value)
}

export class EpochCache<V extends { epoch: number }> {
  private readonly values = new Map<string, V>()
  private readonly floors = new Map<string, number>()

  constructor(private readonly max = 10_000) {}

  /** The lowest epoch this cache may answer with for `key`. */
  floor(key: string): number {
    return this.floors.get(key) ?? Number.NEGATIVE_INFINITY
  }

  /**
   * `key` is at `epoch` or later. A cached value older than that is dropped,
   * and no value older than that is cached or returned again.
   */
  note(key: string, epoch: number): void {
    if (!Number.isFinite(epoch)) return
    if (epoch > this.floor(key)) setBounded(this.floors, key, epoch, this.max)
    const cached = this.values.get(key)
    if (cached && cached.epoch < epoch) this.values.delete(key)
  }

  /** Drop the cached value of `key`, if any. What was noted stays. */
  forget(key: string): void {
    this.values.delete(key)
  }

  clear(): void {
    this.values.clear()
    this.floors.clear()
  }

  /** The cached value, when it is at the noted epoch or later. */
  peek(key: string): V | undefined {
    const cached = this.values.get(key)
    return cached && cached.epoch >= this.floor(key) ? cached : undefined
  }

  /**
   * The value of `key`: the cached one, or `load`'s, which is cached. `load`
   * answering null (no such record) is returned and nothing is cached.
   * `atLeast`, when given, is noted first.
   */
  async get(key: string, load: () => Promise<V | null>, atLeast?: number): Promise<V | null> {
    if (atLeast !== undefined) this.note(key, atLeast)
    const cached = this.peek(key)
    if (cached) return cached

    let behind = Number.NEGATIVE_INFINITY
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      const loaded = await load()
      if (loaded === null) return null
      const floor = this.floor(key)
      if (loaded.epoch < floor) {
        // Read before the move this process has since been told about.
        behind = loaded.epoch
        continue
      }
      // A read that finished meanwhile may have cached a later epoch.
      const current = this.values.get(key)
      if (current && current.epoch > loaded.epoch) return current
      setBounded(this.values, key, loaded, this.max)
      return loaded
    }
    throw new EpochBehindError(key, behind, this.floor(key))
  }
}
