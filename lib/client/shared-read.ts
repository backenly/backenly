/**
 * One request for what several of the console's components read at once.
 *
 * Every console page asked for the signed-in user three or four times, the
 * frontend's connection health two to five times (each copy then polling on
 * its own), and the project's health, state and functions twice, because each
 * component fetched for itself as it mounted (production QA, 2026-11-09:
 * 17-34 requests per page). A read now joins one in flight for the same URL,
 * and an answer under two seconds old is reused, the window SWR dedupes in by
 * default. `fresh` is for a read that must see a change just made: it never
 * reuses an answer, but still joins a request already on its way.
 *
 * Reads go with the session cookie only, as these calls did.
 */

export interface SharedRead<T> {
  ok: boolean
  status: number
  /** The parsed JSON body, or null when there was none. */
  data: T | null
}

export const REUSE_MS = 2000

const inFlight = new Map<string, Promise<SharedRead<unknown>>>()
const answered = new Map<string, { at: number; result: SharedRead<unknown> }>()

export function sharedRead<T = any>(url: string, opts: { fresh?: boolean } = {}): Promise<SharedRead<T>> {
  const kept = answered.get(url)
  if (!opts.fresh && kept && Date.now() - kept.at < REUSE_MS) {
    return Promise.resolve(kept.result as SharedRead<T>)
  }
  const pending = inFlight.get(url)
  if (pending) return pending as Promise<SharedRead<T>>

  const request = (async (): Promise<SharedRead<unknown>> => {
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' })
    let data: unknown = null
    try {
      data = await res.json()
    } catch {
      data = null
    }
    return { ok: res.ok, status: res.status, data }
  })()
  inFlight.set(url, request)
  request
    .then(
      (result) => { answered.set(url, { at: Date.now(), result }) },
      // A request that failed is not kept: the next read tries again.
      () => {},
    )
    .finally(() => {
      if (inFlight.get(url) === request) inFlight.delete(url)
    })
  return request as Promise<SharedRead<T>>
}

/** Forget kept answers for URLs starting with `prefix`, after a change, or all of them. */
export function forgetSharedReads(prefix = ''): void {
  for (const url of [...answered.keys()]) if (url.startsWith(prefix)) answered.delete(url)
}
