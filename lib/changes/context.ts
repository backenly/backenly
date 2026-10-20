/**
 * The async context the change ledger keeps: the governed change open for a
 * project (lib/changes/ledger.ts) and who is acting (./attribution.ts).
 *
 * Node carries an async context into every timer and promise started inside
 * it, so work that outlives the request that scheduled it (the repair loop's
 * kick, a post-build pass, the observer) used to run inside a change that had
 * already closed, joined it as if it were part of it, and was recorded nowhere,
 * attributed to whoever made that change.
 *
 * Its own module, depending only on attribution, so whatever schedules work
 * for later can step outside both without importing the ledger.
 */

import { AsyncLocalStorage } from 'async_hooks'
import { outsideAttribution } from './attribution'

/** What the ledger keeps open: whose change it is, and whether its work is over. */
export interface ChangeContext {
  projectId: string
  /** Set once the change's own work has returned; nothing joins it after that. */
  finished: boolean
}

/** The governed change open in the current async context. Only the ledger runs it. */
export const openChangeContext = new AsyncLocalStorage<ChangeContext>()

/**
 * Run `fn` with no governed change open and no one attributed: for work that is
 * its own actor, whatever request scheduled it. The changes it makes are its
 * own, and Backenly's.
 */
export function outsideAnyChange<T>(fn: () => T): T {
  return openChangeContext.exit(() => outsideAttribution(fn))
}
