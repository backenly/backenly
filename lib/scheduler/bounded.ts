/**
 * A background sweep walks projects a few at a time.
 *
 * Each project may have a database of its own, and reaching one opens
 * connections to it (lib/data-plane/regional.ts). A sweep that starts every
 * project at once would open every database at once; a few at a time keeps the
 * connections it holds to a handful of databases, closing behind it.
 */

/** How many projects a background sweep works on at once. */
export const SWEEP_CONCURRENCY = 4

/**
 * Promise.allSettled over `items`, with at most `concurrency` of `fn` running
 * at any moment. The results are in the order of `items`, exactly as
 * Promise.allSettled gives them, and one failure never stops the rest. A
 * synchronous throw from `fn` is a rejection, as it would be inside an async
 * function.
 */
export async function allSettledBounded<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number = SWEEP_CONCURRENCY,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index], index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  const workers = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length))
  await Promise.all(Array.from({ length: workers }, worker))
  return results
}
