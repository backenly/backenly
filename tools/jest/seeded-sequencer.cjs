/**
 * A test-file sequencer whose order is random but reproducible.
 *
 * WHY
 * ---
 * Written to chase an ordering-dependent flake in `probe fixtures`. That flake
 * did not exist: the failures belonged to `integration suites` and were a
 * deterministic stale fixture. See .github/workflows/flake-hunt.yml.
 *
 * It is kept because it closes a real hole in coverage. Jest's default
 * sequencer is stable for a given checkout -- it orders by failure history then
 * file size -- so every local and CI run had been exercising one arrangement
 * out of many. Suites in these jobs share a single database, so an
 * ordering-dependent leak between them would be invisible to repetition alone.
 * Six random orderings of tests/probes (221 tests) now pass, which is a
 * measured negative result where there was previously no measurement at all.
 *
 * Randomising without recording the seed would trade one unreproducible
 * failure for another. So the seed is printed on every run and honoured from
 * the environment, which makes a failing arrangement replayable exactly:
 *
 *   JEST_ORDER_SEED=1234567 npx jest tests/probes --runInBand  *     --testSequencer '<rootDir>/tools/jest/seeded-sequencer.cjs'
 *
 * Not wired into jest.config.js on purpose. The default order is what normal
 * CI should keep using, because a suite that fails only under one arrangement
 * must be reported as a real defect rather than as noise on an unrelated PR.
 * This is opt-in, for the flake hunt.
 */
const Sequencer = require('@jest/test-sequencer').default

/** Deterministic PRNG. Small, seedable, and good enough to permute a list. */
function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), 1 | t)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function resolveSeed() {
  const fromEnv = process.env.JEST_ORDER_SEED
  if (fromEnv && /^\d+$/.test(fromEnv)) return Number(fromEnv) >>> 0
  return (Math.random() * 0xffffffff) >>> 0
}

class SeededSequencer extends Sequencer {
  sort(tests) {
    const seed = resolveSeed()
    // stderr, not stdout: jest's own reporters own stdout, and this must
    // survive being piped through a result parser.
    process.stderr.write(`\n[seeded-sequencer] JEST_ORDER_SEED=${seed}\n`)

    // Copy before sorting: jest reuses the array it hands in.
    const ordered = [...tests].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const rand = mulberry32(seed)
    // Fisher-Yates, so every permutation is reachable. Sorting by a random key
    // would bias the result and weaken exactly the property being tested.
    for (let i = ordered.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[ordered[i], ordered[j]] = [ordered[j], ordered[i]]
    }
    return ordered
  }

  /** Sharding must stay deterministic, so shard membership is left alone. */
  shard(tests, options) {
    return super.shard(tests, options)
  }
}

module.exports = SeededSequencer
