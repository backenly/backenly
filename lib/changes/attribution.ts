/**
 * Who is acting, for every schema change made in the current request.
 *
 * Set where the identity is known and read by the change ledger when it opens
 * a change (lib/changes/ledger.ts), so no executor has to be told:
 *   - a person's session (lib/auth/route-protection.ts): the dashboard;
 *   - the MCP route: a coding agent's key, on its owner's authority;
 *   - an approval: the person who approved, and the agent that asked;
 *   - a branch merge, the autonomy loop.
 *
 * Its own module, with no dependencies, because the session wrappers every
 * dashboard route goes through import it.
 */

import { AsyncLocalStorage } from 'async_hooks'
import type { ChangeSource } from './types'

export interface ChangeAttribution {
  source: ChangeSource
  /** The person on whose authority this runs. For an agent key, its owner. */
  actorUserId?: string | null
  /** The coding agent's key, when an agent is the caller. */
  apiKeyId?: string | null
  /** Groups several changes made for one request. */
  groupId?: string | null
}

const store = new AsyncLocalStorage<ChangeAttribution>()

/** Say who is acting for everything `fn` changes. Inner calls override outer ones field by field. */
export function withChangeAttribution<T>(attr: ChangeAttribution, fn: () => T): T {
  const outer = store.getStore()
  return store.run({ ...outer, ...attr }, fn)
}

export function currentAttribution(): ChangeAttribution | undefined {
  return store.getStore()
}

/** Run `fn` with no one attributed (./context.ts, outsideAnyChange). */
export function outsideAttribution<T>(fn: () => T): T {
  return store.exit(fn)
}
