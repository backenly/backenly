/**
 * ASYNC TIMEOUT WRAPPER
 * =====================
 * Wraps any promise with a hard timeout. If the promise doesn't resolve
 * within `ms` milliseconds, the wrapper rejects with a TimeoutError.
 *
 * Used to prevent OpenAI calls, DB queries, and other async operations
 * from hanging the entire request indefinitely.
 */

export class TimeoutError extends Error {
  constructor(operation: string, ms: number) {
    super(`${operation} timed out after ${ms}ms`)
    this.name = 'TimeoutError'
  }
}

/**
 * Race a promise against a timeout. Returns the promise result or throws TimeoutError.
 *
 * @param promise  — the async operation to wrap
 * @param ms       — timeout in milliseconds
 * @param label    — human-readable label for error messages (e.g. "buildIntentGraph")
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(label, ms))
    }, ms)

    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err)   => { clearTimeout(timer); reject(err) },
    )
  })
}
